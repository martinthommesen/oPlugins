import { Schema } from "effect"

/**
 * A write-back the plugin declined before writing, for a reason another
 * attempt cannot change, such as a Keychain item without an account name.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ClaudeCodeWriteRefusedError extends Schema.TaggedError<ClaudeCodeWriteRefusedError>()(
  "ClaudeCodeWriteRefusedError",
  { message: Schema.String },
) {}

export default ClaudeCodeWriteRefusedError
