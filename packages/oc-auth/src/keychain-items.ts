import { Effect, Encoding, Option, Result, Schema } from "effect"
import ClaudeCodeStoreError from "./claude-code-store-error.ts"
import type { Duration } from "effect"
import keychainSecurity from "./keychain-security.ts"
import pluginLog from "./plugin-log.ts"
import sources from "./claude-code-sources.ts"

const ACCOUNT_HEX = /"acct"<blob>=0x(?<hex>[0-9A-Fa-f]+)/u,
  ACCOUNT_QUOTED = /"acct"<blob>="(?<name>.*)"[ \t]*$/mu,
  /** Every Claude Code item in a `dump-keychain` listing. */
  CLAUDE_SERVICE = /"(?<service>Claude Code-credentials(?:-[0-9a-f]+)?)"/gu,
  /** A regular expression match with one capture group. */
  Captured = Schema.Tuple([Schema.String, Schema.String]),
  /** Enumerating every Keychain item is slower than fetching one by service. */
  DISCOVERY_TIMEOUT = "5 seconds",
  HEX_ONLY = /^(?:[0-9a-f]{2})+$/u,
  LINE_BREAK = /[\r\n]/u,
  NOT_FOUND = "not_found",
  QUOTE_OR_BACKSLASH = /["\\]/gu,
  /** User-facing messages for the read failures a user can act on. */
  READ_ERRORS: ReadonlyMap<string, string> = new Map([
    [
      "timeout",
      "Keychain read timed out. This can happen on macOS Tahoe. Try restarting Keychain Access.",
    ],
    [
      "locked",
      "macOS Keychain is locked. Please unlock it or run: security unlock-keychain ~/Library/Keychains/login.keychain-db",
    ],
    [
      "denied",
      "Keychain access was denied. Please grant access when prompted by macOS.",
    ],
  ]),
  READ_TIMEOUT = "2 seconds",
  /**
   * Longest line `security -i` reads as one command, newline included. A
   * longer line is split into fragments and the first one still runs, so
   * writing an over-long command this way stores a truncated blob.
   */
  SECURITY_INTERACTIVE_LINE_MAX = 4096,
  /**
   * Every call on the write path, including the account lookup that
   * precedes the write, gets a far larger budget than a standalone read. A
   * read that times out costs a retry; a write that times out after the
   * token exchange already consumed the source's refresh token leaves the
   * store holding a dead credential.
   */
  WRITE_PATH_TIMEOUT = "15 seconds",
  codec = new TextEncoder(),
  /* A match and its capture group, or none when nothing matched. */
  decodeCaptured = Schema.decodeUnknownOption(Captured),
  /*
   * `find-generic-password -w` prints a password holding any byte outside
   * printable ASCII as bare hex. A credential blob is a JSON object, so
   * output that is all hex digits cannot be the blob itself.
   */
  decodePasswordOutput = (output: string): string => {
    if (!HEX_ONLY.test(output)) {
      return output
    }

    return Result.getOrElse(Encoding.decodeHexString(output), () => output)
  },
  /* Quote an argument for `security -i`, which honors quotes and backslashes. */
  interactiveArg = (value: string): string =>
    `"${value.replaceAll(QUOTE_OR_BACKSLASH, String.raw`\$&`)}"`,
  /* The services in `dump`, the primary item first. */
  orderedServices = (dump: string): readonly string[] => {
    const allMatches = Schema.decodeUnknownOption(Schema.Array(Captured))([
        ...dump.matchAll(CLAUDE_SERVICE),
      ]),
      found = new Set(
        Option.getOrElse(allMatches, () => []).map(([, service]) => service),
      )

    return [
      ...[sources.PRIMARY_SERVICE].filter((service) => found.has(service)),
      ...[...found].filter((service) => service !== sources.PRIMARY_SERVICE),
    ]
  },
  /*
   * Parse the `acct` attribute out of `find-generic-password` output. A name
   * of printable ASCII without backslashes prints verbatim between quotes,
   * with inner quotes left unescaped, so the value runs to the last quote on
   * the line. Anything else prints as `0x<hex>` followed by an
   * octal-escaped form, and the hex is the exact name. Reading either form
   * wrong yields a different name, and `add-generic-password -U` under a
   * different name creates a second item instead of updating this one.
   */
  parseKeychainAccount = (output: string): Option.Option<string> =>
    decodeCaptured(ACCOUNT_HEX.exec(output)).pipe(
      Option.flatMap(([, hex]) =>
        Result.getSuccess(Encoding.decodeHexString(hex)),
      ),
      Option.orElse(() =>
        decodeCaptured(ACCOUNT_QUOTED.exec(output)).pipe(
          Option.map(([, name]) => name),
        ),
      ),
    ),
  /* The user-facing message for a failed read of `service`. */
  readErrorMessage = (
    service: string,
    failure: { readonly errorType: string; readonly stderr: string },
  ): string =>
    READ_ERRORS.get(failure.errorType) ??
    `Unexpected failure reading Keychain item "${service}" (${[
      failure.errorType,
      failure.stderr,
    ]
      .filter((part) => part !== "")
      .join(": ")}).`,
  /* A write-path failure as the store error the write-back reports. */
  unreachable = (failure: { readonly message: string }): ClaudeCodeStoreError =>
    ClaudeCodeStoreError.make({ message: failure.message }),
  /*
   * The stored password of `service`, or none when there is no such item.
   * Any other failure carries a message the user can act on.
   */
  viewItem = Effect.fn("KeychainItems.readService")(function* viewItem(
    service: string,
    timeout: Duration.Input,
  ) {
    const read = yield* Effect.result(
      keychainSecurity.security({
        args: ["find-generic-password", "-s", service, "-w"],
        input: Option.none(),
        timeout,
      }),
    )

    if (Result.isSuccess(read)) {
      yield* pluginLog.debug("keychain_read", { service, success: true })

      return Option.some(decodePasswordOutput(read.success.trim()))
    }

    yield* pluginLog.debug("keychain_read_error", {
      errorType: read.failure.errorType,
      service,
    })

    if (read.failure.errorType === NOT_FOUND) {
      return Option.none<string>()
    }

    return yield* ClaudeCodeStoreError.make({
      message: readErrorMessage(service, read.failure),
    })
  }),
  /*
   * The Claude Code items in the Keychain, the primary one first. When they
   * cannot be listed, only the primary item is offered: nearly everyone has
   * it, so it is still worth trying. That is logged as a warning, because
   * accounts missing from /connect look like a bug.
   */
  visibleServices = keychainSecurity
    .security({
      args: ["dump-keychain"],
      input: Option.none(),
      timeout: DISCOVERY_TIMEOUT,
    })
    .pipe(
      // Any-length hex suffix so legacy entries stay discoverable. The
      // Suffix-to-config-dir mapping still only applies to the 8-char
      // Hashes the Claude CLI generates.
      Effect.map((dump) => orderedServices(dump)),
      Effect.tap((services) =>
        pluginLog.debug("keychain_list", { servicesFound: services }),
      ),
      Effect.catchTag(
        "KeychainSecurityError",
        (failure: { readonly errorType: string; readonly message: string }) =>
          pluginLog
            .warning("keychain_list_failed", { errorType: failure.errorType })
            .pipe(
              Effect.andThen(
                pluginLog.debug("keychain_list_failed", {
                  error: failure.message,
                  errorType: failure.errorType,
                }),
              ),
              Effect.as([sources.PRIMARY_SERVICE]),
            ),
      ),
    ),
  /*
   * The account name of a Keychain item, or none when there is no such item
   * or it has no account. A failure to reach the Keychain fails rather than
   * reading as "no account", so the caller can tell a locked Keychain from a
   * missing or malformed item.
   */
  whoseItem = Effect.fn("KeychainItems.accountName")(function* whoseItem(
    service: string,
  ) {
    const output = yield* keychainSecurity
        .security({
          args: ["find-generic-password", "-s", service],
          input: Option.none(),
          timeout: WRITE_PATH_TIMEOUT,
        })
        .pipe(
          Effect.asSome,
          Effect.catchTag(
            "KeychainSecurityError",
            (failure: {
              readonly errorType: string
              readonly message: string
            }) => {
              if (failure.errorType === NOT_FOUND) {
                return Effect.succeed(Option.none<string>())
              }

              return Effect.fail(unreachable(failure))
            },
          ),
        ),
      parsed = output.pipe(Option.flatMap((text) => parseKeychainAccount(text)))

    yield* pluginLog.debug("keychain_account_name", {
      account: Option.getOrElse(parsed, () => ""),
      service,
    })

    return parsed
  }),
  /*
   * Store `blob` as the password of an existing item. The password goes in
   * as hex through `-X`, never through a trailing `-w`. That form prompts
   * twice through getpass, which reads stdin when there is no terminal,
   * keeps 128 characters, and accepts two empty entries, so a piped blob is
   * stored as an empty password while `security` exits 0.
   *
   * The command goes to `security -i` on stdin, so the tokens stay out of
   * the process list. A command too long for one interactive line falls
   * back to argv, where other processes of the same user can see it for the
   * life of the subprocess.
   */
  writePassword = Effect.fn("KeychainItems.addGenericPassword")(
    function* writePassword(service: string, account: string, blob: string) {
      const hex = Encoding.encodeHex(blob),
        line = `add-generic-password -s ${interactiveArg(service)} -a ${interactiveArg(account)} -U -X ${hex}\n`,
        size = codec.encode(line).length

      if (size <= SECURITY_INTERACTIVE_LINE_MAX && !LINE_BREAK.test(account)) {
        return yield* keychainSecurity.security({
          args: ["-i"],
          input: Option.some(line),
          timeout: WRITE_PATH_TIMEOUT,
        })
      }

      yield* pluginLog.debug("keychain_write_argv", { bytes: size, service })

      return yield* keychainSecurity.security({
        args: [
          "add-generic-password",
          "-s",
          service,
          "-a",
          account,
          "-U",
          "-X",
          hex,
        ],
        input: Option.none(),
        timeout: WRITE_PATH_TIMEOUT,
      })
    },
    Effect.asVoid,
    Effect.mapError((failure: { readonly message: string }) =>
      unreachable(failure),
    ),
  )

/** The Claude Code items in the macOS Keychain, through `security`. */
export default Object.freeze({
  READ_TIMEOUT,
  WRITE_PATH_TIMEOUT,
  accountName: whoseItem,
  addGenericPassword: writePassword,
  listServices: visibleServices,
  readService: viewItem,
})
