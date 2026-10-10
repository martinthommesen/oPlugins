import { Clock, Context, Effect, Fiber, Layer, Option, Ref } from "effect"
import CredentialRefresh from "./credential-refresh.ts"
import type { Scope } from "effect"
import type claudeCodeCredential from "./claude-code-credential.ts"

type ClaudeCodeCredential = ReturnType<typeof claudeCodeCredential.fromSource>

/** What the active credential keeps for the plugin's lifetime. */
interface State {
  /** The credential requests use, or none when the active one is not ours. */
  readonly active: Ref.Ref<Option.Option<ClaudeCodeCredential>>
  /** When the store was last re-checked for a rotation made elsewhere. */
  readonly checkedAt: Ref.Ref<number>
  /** Where re-checks run, so one outlives the request that started it. */
  readonly scope: Scope.Scope
}

const NEVER_CHECKED = 0,
  /** How long a re-check of the store stays good on the request path. */
  SOURCE_CACHE_TTL_MS = 30_000,
  /* Whether `left` is `right`: the same token from the same store. */
  matches = (
    left: ClaudeCodeCredential,
    right: ClaudeCodeCredential,
  ): boolean =>
    left.access === right.access &&
    left.metadata.source === right.metadata.source &&
    left.metadata.configDir === right.metadata.configDir,
  /* Adopt `next` in place of `previous`, unless a switch replaced it. */
  promote = (
    state: State,
    previous: ClaudeCodeCredential,
    next: ClaudeCodeCredential,
  ): Effect.Effect<void> =>
    Ref.update(state.active, (active) =>
      active.pipe(
        Option.map((current) => {
          if (matches(current, previous)) {
            return next
          }

          return current
        }),
      ),
    ),
  /*
   * Re-read the store for a rotation made outside OpenCode, and resolve to
   * the credential to use from now on.
   */
  recheck = (
    state: State,
    credential: ClaudeCodeCredential,
  ): Effect.Effect<ClaudeCodeCredential, never, CredentialRefresh> =>
    Effect.gen(function* recheckSource() {
      const refresh = yield* CredentialRefresh,
        result = yield* refresh.adopt(
          Object.freeze({
            access: credential.access,
            expires: credential.expires,
            metadata: credential.metadata,
            refresh: credential.refresh,
          }),
        )

      return yield* CredentialRefresh.Result.$match(result, {
        Adopted: ({ credential: adopted }) =>
          promote(state, credential, adopted).pipe(Effect.as(adopted)),
        Refreshed: () => Effect.succeed(credential),
        Transient: () => Effect.succeed(credential),
        Unchanged: () => Effect.succeed(credential),
      })
    }),
  /* Record the re-check at `now` and start it beside the request. */
  startRecheck = (
    state: State,
    credential: ClaudeCodeCredential,
    now: number,
  ): Effect.Effect<
    Fiber.Fiber<ClaudeCodeCredential>,
    never,
    CredentialRefresh
  > =>
    Ref.set(state.checkedAt, now).pipe(
      Effect.andThen(recheck(state, credential)),
      Effect.forkIn(state.scope),
    ),
  /*
   * `credential`, or, when it expired by `now`, whatever the re-check
   * resolves to: sending an expired token is a certain 401.
   */
  useOrWait = (
    pending: Fiber.Fiber<ClaudeCodeCredential>,
    credential: ClaudeCodeCredential,
    now: number,
  ): Effect.Effect<Option.Option<ClaudeCodeCredential>> => {
    if (credential.expires <= now) {
      return Fiber.join(pending).pipe(Effect.map(Option.some))
    }

    return Effect.succeed(Option.some(credential))
  },
  /*
   * The credential for a request. A store read can take seconds on a slow
   * Keychain, so the once-per-window re-check runs beside the request: the
   * token it may replace stays valid until it expires, and a 401 recovers
   * through adoption anyway.
   */
  whenRequested = Effect.fn("ActiveCredential.forRequest")(
    function* whenRequested(state: State) {
      const active = yield* Ref.get(state.active),
        checkedAt = yield* Ref.get(state.checkedAt),
        now = yield* Clock.currentTimeMillis

      if (Option.isNone(active) || now - checkedAt < SOURCE_CACHE_TTL_MS) {
        return active
      }

      return yield* startRecheck(state, active.value, now).pipe(
        Effect.flatMap((pending) => useOrWait(pending, active.value, now)),
      )
    },
  )

/**
 * The Claude Code credential requests are sent with, kept in step with the
 * host's active connection and with rotations made outside OpenCode.
 */
class ActiveCredential extends Context.Service<
  ActiveCredential,
  {
    /** The credential in use, if the active one is ours. */
    readonly current: Effect.Effect<Option.Option<ClaudeCodeCredential>>
    /** The credential in use, read at once for the host's synchronous transform callbacks. */
    readonly currentUnsafe: () => Option.Option<ClaudeCodeCredential>
    /** The credential for a request, re-checking the store once per window. */
    readonly forRequest: Effect.Effect<Option.Option<ClaudeCodeCredential>>
    /** Use `next` from now on, and re-check its store on the next request. */
    readonly set: (
      next: Option.Option<ClaudeCodeCredential>,
    ) => Effect.Effect<void>
    /** Adopt `next` in place of `previous`, unless a switch replaced it. */
    readonly swap: (
      previous: ClaudeCodeCredential,
      next: ClaudeCodeCredential,
    ) => Effect.Effect<void>
  }
>()("@martinthommesen/oc-auth/active-credential/ActiveCredential") {
  /** The active credential, starting with none. */
  public static readonly layer: Layer.Layer<
    ActiveCredential,
    never,
    CredentialRefresh
  > = Layer.effect(
    ActiveCredential,
    Effect.gen(function* makeActiveCredential() {
      const context = yield* Effect.context<CredentialRefresh>(),
        state: State = {
          active: yield* Ref.make(Option.none<ClaudeCodeCredential>()),
          checkedAt: yield* Ref.make(NEVER_CHECKED),
          scope: yield* Effect.scope,
        }

      return ActiveCredential.of({
        current: Ref.get(state.active),
        currentUnsafe: () => Ref.getUnsafe(state.active),
        forRequest: whenRequested(state).pipe(Effect.provideContext(context)),
        set: (next) =>
          Ref.set(state.active, next).pipe(
            Effect.andThen(Ref.set(state.checkedAt, NEVER_CHECKED)),
          ),
        swap: (previous, next) => promote(state, previous, next),
      })
    }),
  )
}

export default ActiveCredential
