import { Schema } from "effect"

/**
 * A Claude Code credential store could not be read or written: a locked or
 * unreachable Keychain, or a credentials file that exists but cannot be
 * read. The message is meant for the user.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ClaudeCodeStoreError extends Schema.TaggedError<ClaudeCodeStoreError>()(
  "ClaudeCodeStoreError",
  { message: Schema.String },
) {}

export default ClaudeCodeStoreError
