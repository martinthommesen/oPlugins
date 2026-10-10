import { Data } from "effect"

/** The permission effect a review settles on, with the message to show. */
type Settled = Data.TaggedEnum<{
  /** Run the action without asking. */
  Allow: { readonly model: string; readonly rationale: string }
  /** Ask the user, with the reviewer's context in the prompt. */
  Ask: { readonly message: string }
  /** Refuse the action and tell the agent why. */
  Deny: { readonly message: string }
}>

/** Builds and matches review verdicts. */
export default Data.taggedEnum<Settled>()
