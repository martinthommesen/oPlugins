import { Data } from "effect"

/** What to do with a denial after counting it. */
type Decision = Data.TaggedEnum<{
  /** Return the denial to the agent so it can find a safer path. */
  Deny: { readonly consecutive: number; readonly total: number }
  /** Too many denials this turn: hand the decision to the user. */
  Escalate: { readonly consecutive: number; readonly total: number }
}>

/** Builds and matches the denial breaker's decisions. */
export default Data.taggedEnum<Decision>()
