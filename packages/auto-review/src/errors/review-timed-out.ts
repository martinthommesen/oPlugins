import { Schema } from "effect"

/** The review did not finish before the configured deadline. */
class ReviewTimedOut extends Schema.TaggedError<ReviewTimedOut>()(
  "ReviewTimedOut",
  { timeout: Schema.String },
) {}

export { ReviewTimedOut }
