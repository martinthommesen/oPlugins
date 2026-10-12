import { Data } from "effect"

/** What to do with a denial after counting it. */
type Decision = Data.TaggedEnum<{
  /** Return the denial to the agent so it can find a safer path. */
  Deny: { readonly consecutive: number; readonly total: number }
  /** Hand the decision to the user, because the turn reached a denial limit. */
  Escalate: { readonly consecutive: number; readonly total: number }
}>

/** Builds and matches the denial breaker's decisions. */
export default Data.taggedEnum<Decision>()
