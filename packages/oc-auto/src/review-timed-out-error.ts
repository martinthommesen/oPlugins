import { Schema } from "effect"

/** The review did not finish before the configured deadline. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ReviewTimedOut extends Schema.TaggedError<ReviewTimedOut>()(
  "ReviewTimedOut",
  { timeout: Schema.String },
) {}

export default ReviewTimedOut
