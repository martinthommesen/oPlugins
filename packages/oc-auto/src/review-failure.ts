import { Effect, Match } from "effect"
import type AuthUnavailable from "./auth-unavailable-error.ts"
import type ContextUnavailable from "./context-unavailable-error.ts"
import type HostError from "./host-error.ts"
import type MalformedAssessment from "./malformed-assessment-error.ts"
import type ModelUnavailable from "./model-unavailable-error.ts"
import type ReviewTimedOut from "./review-timed-out-error.ts"
import Verdict from "./verdict.ts"
import redact from "@oc-lib/log-redaction/log-redaction.ts"
import requestFailure from "./request-failure.ts"

/** Why a review could not decide, as far as the user is told. */
type ReviewFailure =
  | Readonly<Pick<AuthUnavailable, "_tag" | "reason">>
  | Readonly<Pick<ContextUnavailable, "_tag" | "reason">>
  | Readonly<Pick<HostError, "_tag" | "category" | "operation">>
  | Readonly<Pick<MalformedAssessment, "_tag">>
  | Readonly<Pick<ModelUnavailable, "_tag" | "model" | "status">>
  | (Parameters<typeof requestFailure.logFields>[typeof FIRST] & {
      readonly _tag: "RequestFailed"
    })
  | Readonly<Pick<ReviewTimedOut, "_tag" | "timeout">>

const FIRST = 0,
  /* Why a review failed, in the user's terms. */
  failureReason = (failure: ReviewFailure): string =>
    Match.valueTags(failure, {
      AuthUnavailable: ({ reason }) => reason,
      ContextUnavailable: ({ reason }) => reason,
      HostError: ({ operation }) =>
        `OpenCode failed to answer the plugin's ${operation} call.`,
      MalformedAssessment: () =>
        "The reviewer's answer was not a valid assessment.",
      ModelUnavailable: ({ model, status }) =>
        `The reviewer model ${model} is unavailable (HTTP ${status}).`,
      RequestFailed: (failed) => requestFailure.explain(failed),
      ReviewTimedOut: ({ timeout }) =>
        `The review did not finish within ${timeout}.`,
    }),
  /* Logs the reason the user is told, redacted, at debug level only. */
  noteReason = (failure: ReviewFailure): Effect.Effect<void> => {
    const fields = redact({ reason: failureReason(failure) })

    return Effect.logDebug("auto_review_failure_reason").pipe(
      Effect.annotateLogs(fields),
    )
  },
  /* Hands a request the review could not decide to the user. */
  undecided = (failure: ReviewFailure): ReturnType<typeof Verdict.Ask> =>
    Verdict.Ask({
      message: `Auto-review could not decide: ${failureReason(failure)} Approve or reject this request yourself.`,
    }),
  /*
   * Hands a request the review could not decide to the user, and logs why:
   * a warning that carries metadata only, then the reason at debug level.
   */
  userDecides = (
    failure: ReviewFailure,
  ): Effect.Effect<ReturnType<typeof Verdict.Ask>> =>
    Effect.logWarning("auto_review_failed").pipe(
      Effect.annotateLogs(
        Match.valueTags(failure, {
          AuthUnavailable: () => ({ error: "AuthUnavailable" }),
          ContextUnavailable: () => ({ error: "ContextUnavailable" }),
          HostError: ({ category, operation }) => ({
            category,
            error: "HostError",
            operation,
          }),
          MalformedAssessment: () => ({ error: "MalformedAssessment" }),
          ModelUnavailable: ({ model, status }) => ({
            error: "ModelUnavailable",
            model,
            status,
          }),
          RequestFailed: (failed) => requestFailure.logFields(failed),
          ReviewTimedOut: ({ timeout }) => ({
            error: "ReviewTimedOut",
            timeout,
          }),
        }),
      ),
      Effect.andThen(noteReason(failure)),
      Effect.as(undecided(failure)),
    )

/** What the user is told, and what the log records, when a review fails. */
export default Object.freeze({ userDecides })
