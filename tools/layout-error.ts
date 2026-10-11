import { Schema } from "effect"

/** The layout check found problems, and has printed them. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class LayoutError extends Schema.TaggedError<LayoutError>()("LayoutError", {
  message: Schema.String,
}) {}

export default LayoutError
