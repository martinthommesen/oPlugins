import type AuthUnavailable from "./auth-unavailable-error.ts"
import type ContextUnavailable from "./context-unavailable-error.ts"
import type HostError from "./host-error.ts"
import type MalformedAssessment from "./malformed-assessment-error.ts"
import { Match } from "effect"
import type ModelUnavailable from "./model-unavailable-error.ts"
import type RequestFailed from "./request-failed-error.ts"
import type ReviewTimedOut from "./review-timed-out-error.ts"
import Verdict from "./verdict.ts"

/** Why a review could not decide, as far as the user is told. */
type ReviewFailure =
  | Readonly<Pick<AuthUnavailable, "_tag" | "reason">>
  | Readonly<Pick<ContextUnavailable, "_tag" | "reason">>
  | Readonly<Pick<HostError, "_tag" | "operation">>
  | Readonly<Pick<MalformedAssessment, "_tag">>
  | Readonly<Pick<ModelUnavailable, "_tag" | "model" | "status">>
  | Readonly<Pick<RequestFailed, "_tag" | "operation">>
  | Readonly<Pick<ReviewTimedOut, "_tag" | "timeout">>

/* Why a review failed, in the user's terms. */
const failureReason = (failure: ReviewFailure): string =>
    Match.valueTags(failure, {
      AuthUnavailable: ({ reason }) => reason,
      ContextUnavailable: ({ reason }) => reason,
      HostError: ({ operation }) =>
        `OpenCode could not provide the session (${operation}).`,
      MalformedAssessment: () => "The reviewer's answer was not valid JSON.",
      ModelUnavailable: ({ model, status }) =>
        `The reviewer model ${model} is unavailable (HTTP ${status}).`,
      RequestFailed: ({ operation }) =>
        `The review request failed while running "${operation}".`,
      ReviewTimedOut: ({ timeout }) =>
        `The review did not finish within ${timeout}.`,
    }),
  /* Hands a request the review could not decide to the user. */
  undecided = (failure: ReviewFailure): ReturnType<typeof Verdict.Ask> =>
    Verdict.Ask({
      message: `Auto-review could not decide: ${failureReason(failure)} Approve or reject this request yourself.`,
    })

/** What the user is told when a review fails. */
export default Object.freeze({ failureReason, undecided })
