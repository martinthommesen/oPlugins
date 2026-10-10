import { Data } from "effect"

/**
 * The permission effect a review settles on, with the message to show and,
 * when the reviewer decided, its model and rationale.
 */
type Settled = Data.TaggedEnum<{
  /** Run the action without asking. */
  Allow: { readonly model: string; readonly rationale: string }
  /** Ask the user, because the review could not decide. */
  Ask: { readonly message: string }
  /** Refuse the action and tell the agent why. */
  Deny: {
    readonly message: string
    readonly model: string
    readonly rationale: string
  }
  /** Ask the user, because the reviewer denied too often this turn. */
  Escalate: {
    readonly message: string
    readonly model: string
    readonly rationale: string
  }
}>

/** Builds and matches review verdicts. */
export default Data.taggedEnum<Settled>()
