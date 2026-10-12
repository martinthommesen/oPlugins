import { Effect, Exit, Option, Ref } from "effect"
import ActiveCredential from "./active-credential.ts"
import AnthropicFetch from "./anthropic-fetch.ts"
import type AnthropicFetchError from "./anthropic-fetch-error.ts"
import CredentialRefresh from "./credential-refresh.ts"
import type RequestStates from "./request-states.ts"
import RequestTransforms from "./request-transforms.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import pluginResponses from "./plugin-responses.ts"
import recoveryLog from "./unauthorized-recovery-log.ts"

type RequestState = Option.Option.Value<
  Effect.Success<ReturnType<RequestStates["Service"]["lookup"]>>
>

type ClaudeCodeCredential = RequestState["credential"]

type Refresh = Effect.Success<
  ReturnType<CredentialRefresh["Service"]["refresh"]>
>

type RefreshError = Effect.Error<
  ReturnType<CredentialRefresh["Service"]["refresh"]>
>

/** A step of recovery: the response the caller gets, or why it failed. */
type Step = Effect.Effect<
  Response,
  AnthropicFetchError | RefreshError,
  Recovery
>

/** What recovering from a 401 uses. */
type Recovery =
  | ActiveCredential
  | AnthropicFetch
  | CredentialRefresh
  | RequestTransforms

/** One recovery attempt: the request it replays, and the responses it opened. */
interface Attempt {
  /** Every replay response, so the ones not returned can be released. */
  readonly opened: Ref.Ref<readonly Response[]>
  readonly state: RequestState
}

/** The latest 401 and the credential it was sent with. */
interface Rejected {
  readonly credential: ClaudeCodeCredential
  readonly response: Response
}

const UNAUTHORIZED = 401,
  /*
   * A credential error the user has to act on, as a 401 in the API's own
   * error shape, so the SDK reports its message like any provider error.
   */
  asAuthenticationError = (failure: {
    readonly message: string
  }): Effect.Effect<Response> =>
    recoveryLog
      .authenticationFailed(failure.message)
      .pipe(Effect.as(pluginResponses.authenticationError(failure.message))),
  /* The original 401 for a turn its caller cancelled, which is no failure. */
  asCancelled = (original: Response): Effect.Effect<Response> =>
    recoveryLog.cancelled.pipe(Effect.as(original)),
  /*
   * Any other failure surfaces as the original 401, which the SDK already
   * knows how to report, once `report` logged why. One after the turn was
   * cancelled is the cancellation's doing, such as the replay it aborted,
   * not a failure, so it is not reported.
   */
  asOriginal = (
    original: Response,
    turn: AbortSignal,
    report: Effect.Effect<void>,
  ): Effect.Effect<Response> => {
    if (turn.aborted) {
      return asCancelled(original)
    }

    return report.pipe(Effect.as(original))
  },
  /* Release a response this plugin drops, so its connection is reclaimed now. */
  discard = (response: Response): Effect.Effect<void> =>
    Option.fromNullishOr(response.body).pipe(
      Option.filter(() => !response.bodyUsed),
      Option.match({
        onNone: () => Effect.void,
        // The body may already be errored or locked: nothing to release.
        onSome: (body) =>
          Effect.tryPromise((): PromiseLike<void> => body.cancel()).pipe(
            Effect.ignore,
            Effect.forkDetach,
            Effect.asVoid,
          ),
      }),
    ),
  /* The original 401, once the caller cancels the turn. */
  onceCancelled = (
    original: Response,
    turn: AbortSignal,
  ): Effect.Effect<Response> =>
    Effect.callback<Response>((resume) => {
      const onAbort = (): void => {
        resume(asCancelled(original))
      }

      turn.addEventListener("abort", onAbort, { once: true })

      if (turn.aborted) {
        onAbort()
      }

      return Effect.sync(() => {
        turn.removeEventListener("abort", onAbort)
      })
    }),
  /*
   * Release `original` and every response `attempt` opened, except the one
   * recovery returned. Recovery that ended without a response, interrupted
   * included, returned none of them.
   */
  releaseUnreturned = (
    original: Response,
    attempt: Attempt,
    exit: Exit.Exit<Response>,
  ): Effect.Effect<void> =>
    Ref.get(attempt.opened).pipe(
      Effect.flatMap((opened) =>
        Effect.forEach(
          [original, ...opened].filter(
            (response) =>
              !Option.exists(
                Exit.getSuccess(exit),
                (returned) => returned === response,
              ),
          ),
          (response) => discard(response),
          { discard: true },
        ),
      ),
    ),
  /*
   * Send the request again with `credential`, recording the response. Only
   * the send can be interrupted, so a response that arrived is recorded.
   */
  replay = Effect.fn("UnauthorizedRecovery.replay")(function* replay(
    attempt: Attempt,
    credential: ClaudeCodeCredential,
  ) {
    const builder = yield* RequestTransforms,
      fetch = yield* AnthropicFetch,
      request = yield* builder.replay(attempt.state.snapshot, credential)

    return yield* Effect.uninterruptibleMask((restore) =>
      restore(fetch.send(request)).pipe(
        Effect.tap((response) =>
          Ref.update(attempt.opened, (opened) => [...opened, response]),
        ),
      ),
    )
  }),
  /* Use `next` from now on, and replay with it unless it is the same token. */
  retryWith = Effect.fn("UnauthorizedRecovery.retryWith")(function* retryWith(
    attempt: Attempt,
    rejected: Rejected,
    next: ClaudeCodeCredential,
  ) {
    const active = yield* ActiveCredential

    yield* active.swap(rejected.credential, next)

    if (next.access === rejected.credential.access) {
      yield* recoveryLog.unchanged("refreshed")

      return rejected.response
    }

    return yield* replay(attempt, next)
  }),
  /* What the caller gets once a refresh after `rejected` came to `result`. */
  settle = (attempt: Attempt, result: Refresh, rejected: Rejected): Step =>
    CredentialRefresh.Result.$match(result, {
      Adopted: ({ credential }) => retryWith(attempt, rejected, credential),
      Refreshed: ({ credential }) => retryWith(attempt, rejected, credential),
      Transient: ({ retryAfterMs }) =>
        Effect.succeed(pluginResponses.retryableRefresh(retryAfterMs)),
      Unchanged: () =>
        recoveryLog.unchanged("unchanged").pipe(Effect.as(rejected.response)),
    }),
  /*
   * The replay with an adopted credential, unless it was rejected as well;
   * then the second refresh has nothing left to adopt and refreshes.
   */
  stillRejected = (
    attempt: Attempt,
    adopted: ClaudeCodeCredential,
    replayed: Response,
  ): Step => {
    if (replayed.status !== UNAUTHORIZED) {
      return Effect.succeed(replayed)
    }

    return CredentialRefresh.pipe(
      Effect.flatMap((refresh) =>
        refresh.refresh(claudeCodeCredential.toOAuth(adopted)),
      ),
      Effect.flatMap((result) =>
        settle(attempt, result, { credential: adopted, response: replayed }),
      ),
    )
  },
  /* Use the credential adopted from the store, and replay with it. */
  takeAdopted = (attempt: Attempt, adopted: ClaudeCodeCredential): Step =>
    ActiveCredential.pipe(
      Effect.flatMap((active) =>
        active.swap(attempt.state.credential, adopted),
      ),
      Effect.andThen(replay(attempt, adopted)),
      Effect.flatMap((replayed) => stillRejected(attempt, adopted, replayed)),
    ),
  /*
   * A refresh adopts a credential rotated outside OpenCode before it spends
   * a refresh token, so a first call that adopts is followed by a replay.
   */
  tryRecovery = Effect.fn("UnauthorizedRecovery.attempt")(function* tryRecovery(
    attempt: Attempt,
    original: Response,
  ) {
    const credentials = yield* CredentialRefresh,
      first = yield* credentials.refresh(
        claudeCodeCredential.toOAuth(attempt.state.credential),
      )

    if (CredentialRefresh.Result.$is("Adopted")(first)) {
      return yield* takeAdopted(attempt, first.credential)
    }

    return yield* settle(attempt, first, {
      credential: attempt.state.credential,
      response: original,
    })
  }),
  /*
   * Recover from a 401 on a request this plugin sent. Recovery is
   * best-effort, and nothing escapes it: a credential error the user has to
   * act on becomes a 401 carrying its message; any other failure is warned
   * about and surfaces as the original 401. Cancelling the turn stops
   * recovery wherever it is, and the caller gets the original 401 with no
   * warning; a refresh other callers share runs on.
   * Every response recovery opened but does not return is released, however
   * it ends.
   */
  unauthorized = Effect.fn("UnauthorizedRecovery.recover")(
    function* unauthorized(original: Response, state: RequestState) {
      if (state.snapshot.signal.aborted) {
        return yield* asCancelled(original)
      }

      const recording: Attempt = {
          opened: yield* Ref.make<readonly Response[]>([]),
          state,
        },
        turn = state.snapshot.signal

      return yield* tryRecovery(recording, original).pipe(
        Effect.catchTags({
          AnthropicFetchError: (failure: {
            readonly cause: unknown
            readonly message: string
          }) =>
            asOriginal(
              original,
              turn,
              recoveryLog.sendFailed(failure.cause, failure.message),
            ),
          ClaudeAuthRefreshExhaustedError: asAuthenticationError,
          ClaudeAuthTerminalError: asAuthenticationError,
        }),
        Effect.catchDefect((defect) =>
          asOriginal(original, turn, recoveryLog.unexpectedError(defect)),
        ),
        Effect.raceFirst(onceCancelled(original, turn)),
        Effect.onExit((exit) => releaseUnreturned(original, recording, exit)),
      )
    },
  )

/** Recovering from a 401 on a request this plugin sent. */
export default Object.freeze({ recover: unauthorized })
