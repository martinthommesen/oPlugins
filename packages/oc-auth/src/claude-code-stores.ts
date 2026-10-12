import { Context, Effect, Layer } from "effect"
import type { Crypto, FileSystem, Option, Path } from "effect"
import type { ChildProcessSpawner } from "effect/process"
import type ClaudeAccount from "./claude-account.ts"
import type ClaudeCodeStoreError from "./claude-code-store-error.ts"
import type Environment from "./environment.ts"
import discovery from "./claude-code-discovery.ts"
import writeBacks from "./claude-code-write-back.ts"

type Account = typeof ClaudeAccount.Type

type WriteBack = typeof writeBacks.writeBack

type WriteBackRequest = WriteBack extends (request: infer Request) => object
  ? Request
  : never

type WriteBackResult = Effect.Success<ReturnType<WriteBack>>

/** What the stores need from the platform. */
type StoreServices =
  | ChildProcessSpawner.ChildProcessSpawner
  | Crypto.Crypto
  | Environment
  | FileSystem.FileSystem
  | Path.Path

/**
 * The credential stores Claude Code keeps: macOS Keychain items, reached
 * through the `security` tool, and the credentials file in a Claude Code
 * config directory. The service finds every account, reads what one store
 * holds now, and writes refreshed tokens back into the store they came from.
 */
class ClaudeCodeStores extends Context.Service<
  ClaudeCodeStores,
  {
    /**
     * Every Claude Code account on this machine. Fails only when no account
     * could be read and some store could not be reached, so a locked
     * Keychain is reported rather than shown as "no credentials".
     */
    readonly readAccounts: Effect.Effect<
      readonly Account[],
      ClaudeCodeStoreError
    >
    /** The credentials now in the store that `source` names, if any. */
    readonly readSource: (
      source: string,
      configDir: Option.Option<string>,
    ) => Effect.Effect<
      Option.Option<Account["credentials"]>,
      ClaudeCodeStoreError
    >
    /** Write refreshed tokens back into their store, guarded; never fails. */
    readonly writeBack: (
      request: WriteBackRequest,
    ) => Effect.Effect<WriteBackResult>
  }
>()("@martinthommesen/oc-auth/claude-code-stores/ClaudeCodeStores") {
  /** The stores on this machine. */
  public static readonly layer: Layer.Layer<
    ClaudeCodeStores,
    never,
    StoreServices
  > = Layer.effect(
    ClaudeCodeStores,
    Effect.gen(function* makeStores() {
      const context = yield* Effect.context<StoreServices>()

      return ClaudeCodeStores.of({
        readAccounts: discovery.readAllAccounts.pipe(
          Effect.provideContext(context),
        ),
        readSource: (source, configDir) =>
          discovery
            .readSource(source, configDir)
            .pipe(Effect.provideContext(context)),
        writeBack: (request) =>
          writeBacks.writeBack(request).pipe(Effect.provideContext(context)),
      })
    }),
  )
}

/** @internal */
export default ClaudeCodeStores
