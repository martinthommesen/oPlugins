import { Schema } from "effect"

/** The layout check couldn't read a file or folder it inspects. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class LayoutReadError extends Schema.TaggedError<LayoutReadError>()(
  "LayoutReadError",
  { message: Schema.String },
) {}

export default LayoutReadError
