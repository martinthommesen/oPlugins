import type { Crypto, Duration, FileSystem, Path } from "effect"
import { Effect, Option } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import type ClaudeCodeStoreError from "./claude-code-store-error.ts"
import ClaudeCodeWriteRefusedError from "./claude-code-write-refused-error.ts"
import DebugLog from "./debug-log.ts"
import Environment from "./environment.ts"
import fileStores from "./claude-code-file-store.ts"
import keychainItems from "./keychain-items.ts"
import sources from "./claude-code-sources.ts"

/** What reading and writing a store needs from the platform. */
type StoreServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | DebugLog
  | Environment
  | FileSystem.FileSystem
  | Path.Path

/** One credential store: the credentials file or one Keychain item. */
interface CredentialStore {
  /** Log context for every event this store emits. */
  readonly fields: readonly (readonly [string, string])[]
  /**
   * Do whatever a write needs that can be slow, and return the write
   * itself, so that only the write sits between the guard read and the
   * store.
   */
  readonly prepareWrite: Effect.Effect<
    (blob: string) => Effect.Effect<void, ClaudeCodeStoreError, StoreServices>,
    ClaudeCodeStoreError | ClaudeCodeWriteRefusedError,
    StoreServices
  >
  /** The stored blob, or none when nothing is stored. */
  readonly read: Effect.Effect<
    Option.Option<string>,
    ClaudeCodeStoreError,
    StoreServices
  >
}

const keychainStore = (
    source: string,
    readTimeout: Duration.Input,
  ): CredentialStore => ({
    fields: [["source", source]],
    // `add-generic-password -U` keys on service plus account. Guessing the
    // Account would create a second item instead of updating this one.
    prepareWrite: keychainItems.accountName(source).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new ClaudeCodeWriteRefusedError({
                message: `Keychain item "${source}" is missing or has no account name`,
              }),
            ),
          onSome: (account) =>
            Effect.succeed((blob: string) =>
              keychainItems.addGenericPassword(source, account, blob),
            ),
        }),
      ),
    ),
    read: keychainItems.readService(source, readTimeout),
  }),
  /*
   * The store `source` names, or none when it names nothing this plugin may
   * touch. `readTimeout` bounds each Keychain read: reads on the write path
   * get the long budget, because timing out there reports a write that
   * landed as unsaved.
   */
  storeFor = Effect.fn("ClaudeCodeStores.storeFor")(function* storeFor(
    source: string,
    configDir: Option.Option<string>,
    readTimeout: Duration.Input,
  ) {
    const debug = yield* DebugLog,
      environment = yield* Environment

    if (source === sources.FILE_SOURCE) {
      return Option.some<CredentialStore>(
        yield* fileStores.fileStore(configDir),
      )
    }

    if (environment.process.platform !== "darwin") {
      return Option.none<CredentialStore>()
    }

    if (!sources.isKnownCredentialSource(source)) {
      // `source` round-trips through OpenCode's credential store, so it is
      // Not trusted to still name a Claude Code item by the time it comes
      // Back.
      yield* debug.log("store_rejected_source", { source })

      return Option.none<CredentialStore>()
    }

    return Option.some(keychainStore(source, readTimeout))
  })

/** Choosing the credential store a source names. */
export default Object.freeze({ storeFor })
