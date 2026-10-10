import { Schema } from "effect"

/** A write the store refused for a reason another attempt cannot change. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ClaudeCodeWriteRefusedError extends Schema.TaggedError<ClaudeCodeWriteRefusedError>()(
  "ClaudeCodeWriteRefusedError",
  { message: Schema.String },
) {}

export default ClaudeCodeWriteRefusedError
