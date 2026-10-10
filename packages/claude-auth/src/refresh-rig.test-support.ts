import { Context, Effect, Latch, Layer, Ref } from "effect"
import type { Option, Scope } from "effect"
import type ClaudeCodeStoreError from "./claude-code-store-error.ts"
import ClaudeCodeStores from "./claude-code-stores.ts"
import type ClaudeCredentials from "./claude-credentials.ts"
import type LockAttempt from "./refresh-lock-attempt.ts"
import RefreshLock from "./refresh-lock.ts"
import TokenExchange from "./token-exchange.ts"

type Stores = ClaudeCodeStores["Service"]

type WriteRequest = Parameters<Stores["writeBack"]>[typeof FIRST]

type WriteResult = Effect.Success<ReturnType<Stores["writeBack"]>>

type Attempt = ReturnType<(typeof LockAttempt)["busy" | "cooldown" | "held"]>

type Outcome = Effect.Success<ReturnType<TokenExchange["Service"]["exchange"]>>

type Tokens = typeof ClaudeCredentials.Type

/** How the fake stores, lock, and token endpoint answer. */
interface Script {
  readonly acquire: Effect.Effect<Attempt, never, RefreshRig | Scope.Scope>
  readonly exchange: (
    refreshToken: string,
  ) => Effect.Effect<Outcome, never, RefreshRig>
  readonly read: (
    source: string,
    configDir: Option.Option<string>,
  ) => Effect.Effect<Option.Option<Tokens>, ClaudeCodeStoreError, RefreshRig>
  readonly writeBack: (
    request: WriteRequest,
  ) => Effect.Effect<WriteResult, never, RefreshRig>
}

const FIRST = 0,
  /* `list` with `item` appended. */
  append = <Item>(list: readonly Item[], item: Item): readonly Item[] => [
    ...list,
    item,
  ]

/**
 * What the fake Claude Code stores, refresh lock, and token endpoint a
 * refresh test runs against have seen, and the store's current contents.
 */
class RefreshRig extends Context.Service<
  RefreshRig,
  {
    /** Refresh tokens sent to the token endpoint, in order. */
    readonly exchanged: Ref.Ref<readonly string[]>
    /** Closed until a test opens it; a script may wait on it. */
    readonly gate: Latch.Latch
    /** `defer:<ms>` and `release` for the fake held lock, in order. */
    readonly lockEvents: Ref.Ref<readonly string[]>
    /** The stores asked for, in order. */
    readonly reads: Ref.Ref<
      readonly (readonly [string, Option.Option<string>])[]
    >
    /** What the store holds now. */
    readonly stored: Ref.Ref<Option.Option<Tokens>>
    /** Write-backs asked for, in order. */
    readonly writes: Ref.Ref<readonly WriteRequest[]>
  }
>()("oclaude/test/RefreshRig") {
  /* The fake services over `rig`, answering per `script`. */
  public static readonly fakes = (
    rig: RefreshRig["Service"],
    script: Script,
  ): Context.Context<ClaudeCodeStores | RefreshLock | TokenExchange> =>
    Context.make(
      ClaudeCodeStores,
      ClaudeCodeStores.of({
        readAccounts: Effect.die("readAccounts is not scripted"),
        readSource: (source, configDir) =>
          Ref.update(rig.reads, (reads) =>
            append(reads, [source, configDir] as const),
          ).pipe(
            Effect.andThen(script.read(source, configDir)),
            Effect.provideService(RefreshRig, rig),
          ),
        writeBack: (request) =>
          Ref.update(rig.writes, (writes) => append(writes, request)).pipe(
            Effect.andThen(script.writeBack(request)),
            Effect.provideService(RefreshRig, rig),
          ),
      }),
    ).pipe(
      Context.add(
        RefreshLock,
        RefreshLock.of({
          acquire: () =>
            script.acquire.pipe(Effect.provideService(RefreshRig, rig)),
        }),
      ),
      Context.add(
        TokenExchange,
        TokenExchange.of({
          exchange: (refreshToken) =>
            Ref.update(rig.exchanged, (sent) =>
              append(sent, refreshToken),
            ).pipe(
              Effect.andThen(script.exchange(refreshToken)),
              Effect.provideService(RefreshRig, rig),
            ),
        }),
      ),
    )

  /* Fake stores, lock, and endpoint per `script`, the store holding `stored`. */
  public static readonly layer = (
    script: Script,
    stored: Option.Option<Tokens>,
  ): Layer.Layer<ClaudeCodeStores | RefreshLock | RefreshRig | TokenExchange> =>
    Layer.effectContext(
      Effect.gen(function* makeRig() {
        const rig = RefreshRig.of({
          exchanged: yield* Ref.make<readonly string[]>([]),
          gate: yield* Latch.make(false),
          lockEvents: yield* Ref.make<readonly string[]>([]),
          reads: yield* Ref.make<
            readonly (readonly [string, Option.Option<string>])[]
          >([]),
          stored: yield* Ref.make(stored),
          writes: yield* Ref.make<readonly WriteRequest[]>([]),
        })

        return Context.add(RefreshRig.fakes(rig, script), RefreshRig, rig)
      }),
    )
}

export default RefreshRig
