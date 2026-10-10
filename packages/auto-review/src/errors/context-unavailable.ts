import { Schema } from "effect"

class ContextUnavailable extends Schema.TaggedError<ContextUnavailable>()(
  "ContextUnavailable",
  { reason: Schema.String },
) {}

export { ContextUnavailable }
