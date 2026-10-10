import { Schema } from "effect"

/** The consulting session may not use the advisor right now. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class AdvisorUnavailable extends Schema.TaggedError<AdvisorUnavailable>()(
  "AdvisorUnavailable",
  {
    reason: Schema.String,
  },
) {}

export default AdvisorUnavailable
