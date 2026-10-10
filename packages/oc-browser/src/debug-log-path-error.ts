import { Schema } from "effect"

/** `OBROWSE_DEBUG` names a log file the plugin must not use. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class DebugLogPathError extends Schema.TaggedError<DebugLogPathError>()(
  "DebugLogPathError",
  { message: Schema.String },
) {}

export default DebugLogPathError
