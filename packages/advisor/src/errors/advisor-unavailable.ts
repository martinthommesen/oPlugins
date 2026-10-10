import { Schema } from "effect"

/** The consulting session may not use the advisor right now. */
class AdvisorUnavailable extends Schema.TaggedError<AdvisorUnavailable>()(
  "AdvisorUnavailable",
  {
    reason: Schema.String,
  },
) {}

export { AdvisorUnavailable }
