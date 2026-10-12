import { Effect, Formatter, Option, Predicate } from "effect"
import pluginLog from "./plugin-log.ts"

const FIRST_CAUSE = 0,
  /** How many causes deep a failure is described. */
  MAX_CAUSES = 4,
  NEXT_CAUSE = 1,
  /* Recovery ended in a credential error the user has to act on. */
  authenticationFailed = (message: string): Effect.Effect<void> =>
    pluginLog.debug("unauthorized_recovery_failed", { error: message }),
  /* The caller cancelled the turn, which is no failure. */
  cancelled = pluginLog.debug("unauthorized_recovery_cancelled", {}),
  /* The class name of `cause`, which a warning may carry. */
  errorNameOf = (cause: unknown): string =>
    Option.liftPredicate(cause, Predicate.isError).pipe(
      Option.map((error: { readonly name: string }) => error.name),
      Option.getOrElse(() => "unknown"),
    ),
  /*
   * `cause` and each cause behind it, outermost first, as text for a debug
   * record. A failed `fetch` says only "fetch failed"; its cause says why.
   */
  messagesOf = (cause: unknown, depth: number): readonly string[] => {
    if (depth >= MAX_CAUSES || Predicate.isNullish(cause)) {
      return []
    }

    if (!Predicate.isError(cause)) {
      return [Formatter.format(cause)]
    }

    return [String(cause), ...messagesOf(cause.cause, depth + NEXT_CAUSE)]
  },
  /*
   * Recovery fell back to the original 401. Warn with `event`, which names
   * the kind of failure, carrying the class name of `cause` only; `message`
   * and the causes go in a debug record.
   */
  reportFallback = (
    event: string,
    cause: unknown,
    message: string,
  ): Effect.Effect<void> => {
    const described = pluginLog.debug("unauthorized_recovery_failed", {
      cause: messagesOf(cause, FIRST_CAUSE),
      error: message,
    })

    return pluginLog
      .warning(event, { errorName: errorNameOf(cause) })
      .pipe(Effect.andThen(described))
  },
  /* The replay could not be sent, for `cause`. */
  sendFailed = (cause: unknown, message: string): Effect.Effect<void> =>
    reportFallback("unauthorized_recovery_send_failed", cause, message),
  /* A refresh kept the access token: replaying it would earn another 401. */
  unchanged = (kind: string): Effect.Effect<void> =>
    pluginLog.debug("unauthorized_recovery_unchanged", { kind }),
  /* Recovery failed with `cause`, an error nothing expected. */
  unexpectedError = (cause: unknown): Effect.Effect<void> =>
    reportFallback(
      "unauthorized_recovery_unexpected_error",
      cause,
      "unauthorized recovery failed unexpectedly",
    )

/** The log records of unauthorized recovery. */
export default Object.freeze({
  authenticationFailed,
  cancelled,
  sendFailed,
  unchanged,
  unexpectedError,
})
