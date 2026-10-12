import { Effect, Option } from "effect"
import type ClaudeAccount from "./claude-account.ts"
import accountLabels from "./claude-code-account-labels.ts"
import configDirs from "./claude-config-dirs.ts"
import credentialBlob from "./claude-credentials-blob.ts"
import fileStores from "./claude-code-file-store.ts"
import pluginLog from "./plugin-log.ts"
import sources from "./claude-code-sources.ts"

type Account = typeof ClaudeAccount.Type

type Credentials = Account["credentials"]

/** An account before it is labeled. */
interface UnlabeledAccount {
  /** The config directory the account belongs to, when known. */
  readonly configDir: Option.Option<string>
  /** The credentials its store holds. */
  readonly credentials: Credentials
  /** The `source` that names its store. */
  readonly source: string
}

const FIRST = 0,
  /* `item` as an account, with its config directory when known. */
  accountOf = (item: UnlabeledAccount, label: string): Account =>
    Option.match(item.configDir, {
      onNone: (): Account => ({
        credentials: item.credentials,
        label,
        source: item.source,
      }),
      onSome: (configDir): Account => ({
        configDir,
        credentials: item.credentials,
        label,
        source: item.source,
      }),
    }),
  /* The credentials a stored blob holds; an empty blob holds none. */
  credentialsIn = (
    raw: Option.Option<string>,
  ): Effect.Effect<Option.Option<Credentials>> =>
    Option.match(raw.pipe(Option.filter((blob) => blob !== "")), {
      onNone: () => Effect.succeed(Option.none<Credentials>()),
      onSome: (blob) => credentialBlob.parseCredentials(blob),
    }),
  /* The one account of the credentials file in `configDir`. */
  fileAccountIn = Effect.fn("ClaudeCodeFileAccounts.fileAccountIn")(
    function* fileAccountIn(configDir: string, credentials: Credentials) {
      const email = yield* configDirs.readEmail(configDir),
        labels = accountLabels.buildAccountLabels([
          { credentials, email, source: Option.none() },
        ])

      return [
        accountOf(
          {
            configDir: Option.some(configDir),
            credentials,
            source: sources.FILE_SOURCE,
          },
          labels[FIRST] ?? "",
        ),
      ]
    },
  ),
  /*
   * The credentials in the credentials file of `configDir`, or none when
   * there is no file or it holds no usable credential. A file that exists but cannot be read
   * fails, because reporting a permission problem as "no credentials" sends
   * the user to log in again for nothing.
   */
  fromFile = Effect.fn("ClaudeCodeFileAccounts.readCredentialsFile")(
    function* fromFile(configDir: Option.Option<string>) {
      const dir = yield* sources.resolveConfigDir(configDir),
        fileAt = yield* fileStores.fileStore(configDir),
        stored = yield* fileAt.read.pipe(
          Effect.tapError((failure: { readonly message: string }) =>
            pluginLog.debug("credentials_file_read", {
              configDir: dir,
              error: failure.message,
              success: false,
            }),
          ),
        ),
        usable = yield* credentialsIn(stored)

      yield* pluginLog.debug(
        "credentials_file_read",
        Option.match(stored, {
          onNone: () => ({
            configDir: dir,
            missing: true,
            success: Option.isSome(usable),
          }),
          onSome: () => ({ configDir: dir, success: Option.isSome(usable) }),
        }),
      )

      return usable
    },
  ),
  /* The account in the configured credentials file, if any. */
  onlyFileAccount = Effect.gen(function* onlyFileAccount() {
    const configDir = yield* sources.resolveConfigDir(Option.none()),
      found = yield* fromFile(Option.some(configDir))

    return yield* Option.match(found, {
      onNone: () => Effect.succeed<readonly Account[]>([]),
      onSome: (credentials) => fileAccountIn(configDir, credentials),
    })
  })

/** The account in the Claude Code credentials file, and reading that file. */
export default Object.freeze({
  accountOf,
  credentialsIn,
  fileAccount: onlyFileAccount,
  readCredentialsFile: fromFile,
})
