import { Schema } from "effect"

/**
 * A Claude Code credential store could not be read or written: the Keychain
 * is locked or does not answer, or the credentials file exists but cannot be
 * read or replaced. The message of a failed read is for the user.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ClaudeCodeStoreError extends Schema.TaggedError<ClaudeCodeStoreError>()(
  "ClaudeCodeStoreError",
  { message: Schema.String },
) {}

export default ClaudeCodeStoreError
