import { Schema } from "effect"

/** OpenCode could not provide the evidence a review needs. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ContextUnavailable extends Schema.TaggedError<ContextUnavailable>()(
  "ContextUnavailable",
  { reason: Schema.String },
) {}

export default ContextUnavailable
