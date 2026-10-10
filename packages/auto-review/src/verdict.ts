import { Data, Match } from "effect"
import type { Assessment } from "./assessment.ts"
import type { HostError } from "./errors/host-error.ts"
import { REJECTION_INSTRUCTIONS } from "./vendor/codex/messages.ts"
import type { ReviewError } from "./reviewer.ts"

/** The permission effect a review settles on, with the message to show. */
type Verdict = Data.TaggedEnum<{
  /** Run the action without asking. */
  Allow: { readonly model: string; readonly rationale: string }
  /** Ask the user, with the reviewer's context in the prompt. */
  Ask: { readonly message: string }
  /** Refuse the action and tell the agent why. */
  Deny: { readonly message: string }
}>

const Verdict = Data.taggedEnum<Verdict>()

/**
 * Explains a denial to the agent, with Codex's instructions for recovering.
 * @param {Assessment} assessment The reviewer's assessment.
 * @returns {string} The denial reason the agent receives.
 */
const denialMessage = (assessment: Assessment): string =>
  [
    `Auto-review denied this action (risk: ${assessment.riskLevel}, user authorization: ${assessment.userAuthorization}): ${assessment.rationale}`,
    REJECTION_INSTRUCTIONS,
  ].join("\n\n")

/**
 * Explains to the user why a denial was handed to them.
 * @param {Assessment} assessment The reviewer's latest assessment.
 * @param {number} total Denials counted this turn.
 * @returns {string} The note shown in the permission prompt.
 */
const escalationMessage = (assessment: Assessment, total: number): string =>
  `Auto-review has denied ${total} actions this turn, so it is asking you instead. Its reason for this one (risk: ${assessment.riskLevel}): ${assessment.rationale}`

/**
 * Describes why a review produced no verdict.
 * @param {HostError | ReviewError} failure The review's failure.
 * @returns {string} A short reason.
 */
const failureReason = (failure: HostError | ReviewError): string =>
  Match.valueTags(failure, {
    AuthUnavailable: ({ reason }) => reason,
    HostError: ({ operation }) =>
      `OpenCode could not provide the session (${operation}).`,
    MalformedAssessment: () => "The reviewer's answer was not valid JSON.",
    ModelUnavailable: ({ model, status }) =>
      `The reviewer model ${model} is unavailable (HTTP ${status}).`,
    RequestFailed: ({ operation }) =>
      `The review request failed while running "${operation}".`,
    ReviewTimedOut: ({ timeout }) =>
      `The review did not finish within ${timeout}.`,
  })

/**
 * Hands a request the reviewer could not decide back to the user.
 * @param {HostError | ReviewError} failure The review's failure.
 * @returns {Verdict} An `Ask` verdict explaining the failure.
 */
const undecided = (failure: HostError | ReviewError): Verdict =>
  Verdict.Ask({
    message: `Auto-review could not decide: ${failureReason(failure)} Approve or reject this request yourself.`,
  })

export { Verdict, denialMessage, escalationMessage, failureReason, undecided }
