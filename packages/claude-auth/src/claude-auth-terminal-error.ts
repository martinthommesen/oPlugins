import { Schema } from "effect"

/**
 * The refresh token was rejected for good. Latched for that credential
 * generation until the user re-authenticates with `claude`.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ClaudeAuthTerminalError extends Schema.TaggedError<ClaudeAuthTerminalError>()(
  "ClaudeAuthTerminalError",
  { message: Schema.String },
) {
  /** The one message this error carries. */
  public static readonly text =
    "Claude Code credentials could not be renewed. Run `claude` to authenticate the selected account, then try again."
}

export default ClaudeAuthTerminalError
