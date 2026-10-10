import { Effect, Option, Result, Schema } from "effect"
import type ClaudeAccount from "./claude-account.ts"
import DebugLog from "./debug-log.ts"
import Environment from "./environment.ts"
import accountLabels from "./claude-code-account-labels.ts"
import configDirs from "./claude-config-dirs.ts"
import fileAccounts from "./claude-code-file-accounts.ts"
import keychainItems from "./keychain-items.ts"
import sources from "./claude-code-sources.ts"
import storeSelect from "./claude-code-store-select.ts"

type Credentials = (typeof ClaudeAccount.Type)["credentials"]

type ReadFailure = Effect.Error<ReturnType<typeof keychainItems.readService>>

/** A Keychain item that holds a usable credential. */
interface FoundItem {
  readonly credentials: Credentials
  readonly source: string
}

/** A found item with what its config directory says about it. */
interface PlacedItem extends FoundItem {
  readonly configDir: Option.Option<string>
  readonly email: Option.Option<string>
}

/** What a credential read found in one Keychain item. */
interface ItemRead {
  readonly read: Result.Result<Option.Option<Credentials>, ReadFailure>
  readonly source: string
}

/** Where the config directory of a Keychain item can come from. */
interface DirIndex {
  readonly bySuffix: Readonly<Record<string, string>>
  readonly primary: string
}

const Captured = Schema.Tuple([Schema.String, Schema.String]),
  NONE = 0,
  /** The 8-character config-directory hash a non-primary item name ends in. */
  SUFFIX = /-(?<suffix>[0-9a-f]{8})$/u,
  /* `item` placed in `configDir`, whose account file names `email`. */
  atDir = (
    item: FoundItem,
    configDir: Option.Option<string>,
    email: Option.Option<string>,
  ): PlacedItem => ({
    configDir,
    credentials: item.credentials,
    email,
    source: item.source,
  }),
  /* The config-directory hash `source` ends in, when it has one. */
  hashSuffix = (source: string): Option.Option<string> =>
    Schema.decodeUnknownOption(Captured)(SUFFIX.exec(source)).pipe(
      Option.map(([, suffix]) => suffix),
    ),
  /*
   * Every Claude Code item in the Keychain, read at once. One inaccessible
   * item does not hide the others.
   */
  itemReads = Effect.gen(function* itemReads() {
    const listed = yield* keychainItems.listServices,
      reads: readonly ItemRead[] = yield* Effect.forEach(
        listed,
        (source) =>
          keychainItems.readService(source, keychainItems.READ_TIMEOUT).pipe(
            Effect.flatMap((raw) => fileAccounts.credentialsIn(raw)),
            Effect.result,
            Effect.map((read) => ({ read, source })),
          ),
        { concurrency: "unbounded" },
      )

    return {
      failure: Option.firstSomeOf(
        reads.map((item) => Result.getFailure(item.read)),
      ),
      found: reads.flatMap((item) =>
        Option.toArray(Result.getOrElse(item.read, () => Option.none())).map(
          (credentials): FoundItem => ({ credentials, source: item.source }),
        ),
      ),
    }
  }),
  /* `item` with its config directory and that directory's account email. */
  placeItem = Effect.fn("ClaudeCodeDiscovery.placeItem")(function* placeItem(
    item: FoundItem,
    dirs: DirIndex,
  ) {
    const configDir = Option.some(dirs.primary).pipe(
        Option.filter(() => item.source === sources.PRIMARY_SERVICE),
        Option.orElse(() =>
          hashSuffix(item.source).pipe(
            Option.flatMap((suffix) =>
              Option.fromUndefinedOr(dirs.bySuffix[suffix]),
            ),
          ),
        ),
      ),
      debug = yield* DebugLog,
      email = yield* Option.match(configDir, {
        onNone: () => Effect.succeed(Option.none<string>()),
        onSome: (dir) => configDirs.readEmail(dir),
      })

    yield* debug.log(
      "account_config_dir",
      Option.match(configDir, {
        onNone: () => ({ source: item.source }),
        onSome: (dir) => ({ configDir: dir, source: item.source }),
      }),
    )

    return atDir(item, configDir, email)
  }),
  /* Every found item as an account, labelled to tell them apart. */
  toAccounts = Effect.fn("ClaudeCodeDiscovery.toAccounts")(function* toAccounts(
    found: readonly FoundItem[],
  ) {
    const dirs = {
        bySuffix: yield* configDirs.configDirsBySuffix(
          found.flatMap((item) => Option.toArray(hashSuffix(item.source))),
        ),
        primary: yield* sources.primaryConfigDir,
      },
      placed: readonly PlacedItem[] = yield* Effect.forEach(
        found,
        (item) => placeItem(item, dirs),
        { concurrency: "unbounded" },
      ),
      titles = accountLabels.buildAccountLabels(
        placed.map((item) => ({
          credentials: item.credentials,
          email: item.email,
          source: Option.some(item.source),
        })),
      )

    return placed.map((item, index) =>
      fileAccounts.accountOf(item, titles[index] ?? ""),
    )
  }),
  /*
   * The accounts in the Keychain. An inaccessible item's error is reported
   * only when no account could be read at all, so a locked Keychain is
   * reported rather than shown as "no credentials". Items without a usable
   * credential (an mcpOAuth-only blob, say) are skipped, and with none left
   * the credentials file is tried.
   */
  viaKeychain = Effect.gen(function* viaKeychain() {
    const scan = yield* itemReads

    if (scan.found.length > NONE) {
      return yield* toAccounts(scan.found)
    }

    if (Option.isSome(scan.failure)) {
      return yield* scan.failure.value
    }

    return yield* fileAccounts.fileAccount
  }),
  /* The credentials `source` holds now, or none when it holds none. */
  whatSourceHolds = Effect.fn("ClaudeCodeDiscovery.readSource")(
    function* whatSourceHolds(
      source: string,
      configDir: Option.Option<string>,
    ) {
      if (source === sources.FILE_SOURCE) {
        return yield* fileAccounts.readCredentialsFile(configDir)
      }

      const selected = yield* storeSelect.storeFor(
          source,
          configDir,
          keychainItems.READ_TIMEOUT,
        ),
        stored = yield* Option.match(selected, {
          onNone: () => Effect.succeed(Option.none<string>()),
          onSome: (store) => store.read,
        })

      return yield* fileAccounts.credentialsIn(stored)
    },
  ),
  /* Every Claude Code account on this machine. */
  wholeMachine = Effect.gen(function* wholeMachine() {
    const environment = yield* Environment

    if (environment.process.platform !== "darwin") {
      return yield* fileAccounts.fileAccount
    }

    return yield* viaKeychain
  })

/** Finding the Claude Code accounts on this machine and reading their stores. */
export default Object.freeze({
  readAllAccounts: wholeMachine,
  readSource: whatSourceHolds,
})
