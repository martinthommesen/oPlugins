import { Effect, Option } from "effect"
import ClaudeAuthTerminalError from "./claude-auth-terminal-error.ts"
import RefreshBackoff from "./refresh-backoff.ts"
import RefreshResult from "./credential-refresh-result.ts"
import adoption from "./credential-adoption.ts"
import type keys from "./credential-refresh-keys.ts"
import pluginLog from "./plugin-log.ts"

type Subject = Effect.Success<ReturnType<typeof keys.subjectOf>>

type Refresh = ReturnType<
  (typeof RefreshResult)["Adopted" | "Refreshed" | "Transient" | "Unchanged"]
>

const NO_WAIT = 0,
  /* The refresh token was rejected for good. */
  latched = ClaudeAuthTerminalError.make({
    message: ClaudeAuthTerminalError.text,
  }),
  /*
   * Why a refresh of `subject` must not go ahead now: a terminal failure
   * latched for its credential generation, which fails, or a cooldown for its
   * store. None when the refresh may go ahead.
   */
  refreshBlocked = Effect.fn("CredentialRefresh.refreshBlocked")(
    function* refreshBlocked(subject: Subject) {
      const backoff = yield* RefreshBackoff,
        kind = yield* backoff.failureKind(subject.credentialKey),
        retryAfterMs = yield* backoff.cooldownRemainingMs(subject.sourceKey)

      if (Option.contains(kind, "terminal")) {
        return yield* latched
      }

      if (retryAfterMs > NO_WAIT) {
        return Option.some(RefreshResult.Transient({ retryAfterMs }))
      }

      return Option.none()
    },
  ),
  /*
   * The refresh token was rejected: adopt a credential Claude Code or another
   * process wrote to the store meanwhile, else latch the failure for this
   * credential generation.
   */
  rejected = Effect.fn("CredentialRefresh.rejected")(function* rejected(
    subject: Subject,
    failure: {
      readonly oauthError: Option.Option<string>
      readonly status: number
    },
  ) {
    const backoff = yield* RefreshBackoff,
      winner = yield* adoption.adoptExternal(subject)

    if (RefreshResult.$is("Adopted")(winner)) {
      return winner
    }

    yield* backoff.noteTerminal(subject.credentialKey)
    yield* pluginLog.debug("refresh_terminal", {
      oauthError: Option.getOrUndefined(failure.oauthError),
      source: subject.credential.metadata.source,
      status: failure.status,
    })

    return yield* latched
  }),
  /* Run `next` unless a refresh of `subject` is blocked right now. */
  unlessBlocked = <Failure, Requirements>(
    subject: Subject,
    next: () => Effect.Effect<Refresh, Failure, Requirements>,
  ): Effect.Effect<
    Refresh,
    ClaudeAuthTerminalError | Failure,
    RefreshBackoff | Requirements
  > =>
    refreshBlocked(subject).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => next(),
          onSome: (blocked): Effect.Effect<Refresh> => Effect.succeed(blocked),
        }),
      ),
    ),
  /* Whether `result` carries a credential adopted from the store. */
  wasAdopted = RefreshResult.$is("Adopted")

/** The checks that stop a refresh, and the latch for a rejected refresh token. */
export default Object.freeze({ rejected, unlessBlocked, wasAdopted })
