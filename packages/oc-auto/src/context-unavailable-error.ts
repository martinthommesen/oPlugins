import { Schema } from "effect"

/** The evidence a review needs is missing, or too large to show the reviewer whole. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ContextUnavailable extends Schema.TaggedError<ContextUnavailable>()(
  "ContextUnavailable",
  { reason: Schema.String },
) {}

export default ContextUnavailable
