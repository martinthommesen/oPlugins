import { Effect, Option, Predicate, Ref } from "effect"
import ActiveCredential from "./active-credential.ts"
import AnthropicFetch from "./anthropic-fetch.ts"
import type AnthropicFetchError from "./anthropic-fetch-error.ts"
import CredentialRefresh from "./credential-refresh.ts"
import type RequestStates from "./request-states.ts"
import RequestTransforms from "./request-transforms.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import pluginLog from "./plugin-log.ts"
import pluginResponses from "./plugin-responses.ts"

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
    pluginLog
      .debug("unauthorized_recovery_failed", { error: failure.message })
      .pipe(Effect.as(pluginResponses.authenticationError(failure.message))),
  /*
   * Any other failure surfaces as the original 401, which the SDK already
   * knows how to report.
   */
  asOriginal = (original: Response, message: string): Effect.Effect<Response> =>
    pluginLog
      .debug("unauthorized_recovery_failed", { error: message })
      .pipe(Effect.as(original)),
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
  /* A refresh that kept the access token: replaying it would earn another 401. */
  logUnchanged = (kind: string): Effect.Effect<void> =>
    pluginLog.debug("unauthorized_recovery_unchanged", { kind }),
  /* Send the request again with `credential`, recording the response. */
  replay = Effect.fn("UnauthorizedRecovery.replay")(function* replay(
    attempt: Attempt,
    credential: ClaudeCodeCredential,
  ) {
    const builder = yield* RequestTransforms,
      fetch = yield* AnthropicFetch,
      request = yield* builder.replay(attempt.state.snapshot, credential),
      response = yield* fetch.send(request)

    yield* Ref.update(attempt.opened, (opened) => [...opened, response])

    return response
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
      yield* logUnchanged("refreshed")

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
        logUnchanged("unchanged").pipe(Effect.as(rejected.response)),
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
   * act on becomes a 401 carrying its message; an aborted turn or any other
   * failure surfaces as the original 401. Every response it opened but does
   * not return is released.
   */
  unauthorized = Effect.fn("UnauthorizedRecovery.recover")(
    function* unauthorized(original: Response, state: RequestState) {
      if (state.snapshot.signal.aborted) {
        return original
      }

      const opened = yield* Ref.make<readonly Response[]>([]),
        recording: Attempt = { opened, state },
        resolved = yield* tryRecovery(recording, original).pipe(
          Effect.catchTags({
            AnthropicFetchError: (failure: { readonly message: string }) =>
              asOriginal(original, failure.message),
            ClaudeAuthRefreshExhaustedError: asAuthenticationError,
            ClaudeAuthTerminalError: asAuthenticationError,
          }),
          Effect.catchDefect((defect) =>
            asOriginal(
              original,
              Option.liftPredicate(defect, Predicate.isError).pipe(
                Option.map(
                  (error: { readonly message: string }) => error.message,
                ),
                Option.getOrElse(() => "unexpected failure"),
              ),
            ),
          ),
        ),
        toRelease = [original, ...(yield* Ref.get(opened))]

      yield* Effect.forEach(
        toRelease.filter((response) => response !== resolved),
        (response) => discard(response),
        { discard: true },
      )

      return resolved
    },
  )

/** Recovering from a 401 on a request this plugin sent. */
export default Object.freeze({ recover: unauthorized })
