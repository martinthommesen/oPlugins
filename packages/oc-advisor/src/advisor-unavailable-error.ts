import { Schema } from "effect"

/** The consulting session may not use the advisor right now. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class AdvisorUnavailable extends Schema.TaggedError<AdvisorUnavailable>()(
  "AdvisorUnavailable",
  {
    /** Why the session may not consult it, such as "the advisor is turned off". */
    reason: Schema.String,
  },
) {}

export default AdvisorUnavailable
