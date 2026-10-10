import {
  Clock,
  Context,
  Data,
  Effect,
  HashMap,
  Layer,
  Option,
  Random,
  Ref,
} from "effect"
import Environment from "./environment.ts"
import policy from "./refresh-backoff-policy.ts"

/*
 * What is known about one key. Transient state is kept per source and
 * terminal state per credential generation, so the two never share a key in
 * practice. With one map they cannot hold conflicting state for a key anyway.
 */
type BackoffState =
  | { readonly _tag: "Terminal" }
  | {
      readonly _tag: "Transient"
      readonly consecutive: number
      readonly until: number
    }

type RefreshFailureKind = ReturnType<typeof policy.classify>

/** The state one backoff tracker owns for the plugin's lifetime. */
interface Backoff {
  /** Base cooldown after the first transient failure. */
  readonly baseMs: number
  readonly states: Ref.Ref<HashMap.HashMap<string, BackoffState>>
}

const NEXT = 1,
  NO_WAIT = 0,
  State = Data.taggedEnum<BackoffState>(),
  /* The transient state recorded for `key`, if that is what it holds. */
  activeTransient = (
    states: HashMap.HashMap<string, BackoffState>,
    key: string,
  ): Option.Option<{ readonly consecutive: number; readonly until: number }> =>
    HashMap.get(states, key).pipe(
      Option.flatMap(
        State.$match({
          Terminal: () => Option.none(),
          Transient: (state) => Option.some(state),
        }),
      ),
    ),
  /* How long the cooldown for `key` has left to run, or 0 when none. */
  cooldownRemainingMs = Effect.fn("RefreshBackoff.cooldownRemainingMs")(
    function* cooldownRemainingMs(backoff: Backoff, key: string) {
      const now = yield* Clock.currentTimeMillis,
        states = yield* Ref.get(backoff.states)

      return Option.match(activeTransient(states, key), {
        onNone: () => NO_WAIT,
        onSome: (state) => Math.max(NO_WAIT, state.until - now),
      })
    },
  ),
  /* Consecutive transient failures recorded for `key`. */
  countOf = (
    states: HashMap.HashMap<string, BackoffState>,
    key: string,
  ): number =>
    Option.match(activeTransient(states, key), {
      onNone: () => NO_WAIT,
      onSome: (state) => state.consecutive,
    }),
  /* Whether the last failure recorded for `key` was transient or terminal. */
  failureKind = (
    backoff: Backoff,
    key: string,
  ): Effect.Effect<Option.Option<RefreshFailureKind>> =>
    Ref.get(backoff.states).pipe(
      Effect.map((states) =>
        HashMap.get(states, key).pipe(
          Option.map(
            State.$match({
              Terminal: (): RefreshFailureKind => "terminal",
              Transient: (): RefreshFailureKind => "transient",
            }),
          ),
        ),
      ),
    ),
  makeTerminal = State.Terminal,
  makeTransient = State.Transient,
  /*
   * Record a transient refresh failure for `key` and return the cooldown
   * duration applied. The cooldown escalates with consecutive transient
   * failures and is exposed via `cooldownRemainingMs`.
   */
  noteTransient = Effect.fn("RefreshBackoff.noteTransient")(
    function* noteTransient(
      backoff: Backoff,
      key: string,
      retryAfterMs: Option.Option<number>,
    ) {
      const jitter = yield* Random.next,
        now = yield* Clock.currentTimeMillis

      return yield* Ref.modify(backoff.states, (states) => {
        const consecutive = countOf(states, key) + NEXT,
          ms = policy.backoffMs({
            baseMs: backoff.baseMs,
            consecutive,
            jitter,
            retryAfterMs,
          })

        return [
          ms,
          HashMap.set(
            states,
            key,
            makeTransient({ consecutive, until: now + ms }),
          ),
        ]
      })
    },
  )

/**
 * Per-key backoff for OAuth token refreshes: an escalating cooldown after
 * transient failures, and a latch for terminal ones. The state lives as long
 * as the layer that built it.
 */
class RefreshBackoff extends Context.Service<
  RefreshBackoff,
  {
    /** Clear all backoff state for `key` after a successful refresh or adoption. */
    readonly clear: (key: string) => Effect.Effect<void>
    /** How long the cooldown for `key` has left to run, or 0 when none. */
    readonly cooldownRemainingMs: (key: string) => Effect.Effect<number>
    /** Whether the last failure recorded for `key` was transient or terminal. */
    readonly failureKind: (
      key: string,
    ) => Effect.Effect<Option.Option<RefreshFailureKind>>
    /** Record a terminal refresh failure (dead refresh token). No cooldown. */
    readonly noteTerminal: (key: string) => Effect.Effect<void>
    /** Record a transient refresh failure and return the cooldown applied. */
    readonly noteTransient: (
      key: string,
      retryAfterMs: Option.Option<number>,
    ) => Effect.Effect<number>
    /** Consecutive transient failures recorded for `key`. */
    readonly transientCount: (key: string) => Effect.Effect<number>
  }
>()("oclaude/refresh-backoff/RefreshBackoff") {
  /** A fresh tracker whose base cooldown comes from the environment. */
  public static readonly layer: Layer.Layer<
    RefreshBackoff,
    never,
    Environment
  > = Layer.effect(
    RefreshBackoff,
    Effect.gen(function* makeRefreshBackoff() {
      const environment = yield* Environment,
        tracker: Backoff = {
          baseMs: environment.variables.refreshCooldownMs,
          states: yield* Ref.make(HashMap.empty<string, BackoffState>()),
        }

      return RefreshBackoff.of({
        clear: (key) =>
          Ref.update(tracker.states, (states) => HashMap.remove(states, key)),
        cooldownRemainingMs: (key) => cooldownRemainingMs(tracker, key),
        failureKind: (key) => failureKind(tracker, key),
        noteTerminal: (key) =>
          Ref.update(tracker.states, (states) =>
            HashMap.set(states, key, makeTerminal()),
          ),
        noteTransient: (key, retryAfterMs) =>
          noteTransient(tracker, key, retryAfterMs),
        transientCount: (key) =>
          Ref.get(tracker.states).pipe(
            Effect.map((states) => countOf(states, key)),
          ),
      })
    }),
  )
}

export default RefreshBackoff
