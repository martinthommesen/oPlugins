import { Schema } from "effect"

/**
 * Token refresh failed too many times in a row, for reasons that say nothing
 * against the refresh token: the network, the token endpoint, or the
 * credential store. Unlike `ClaudeAuthTerminalError`, nothing is latched, so
 * the next attempt after the cooldown goes out as usual.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ClaudeAuthRefreshExhaustedError extends Schema.TaggedError<ClaudeAuthRefreshExhaustedError>()(
  "ClaudeAuthRefreshExhaustedError",
  { message: Schema.String },
) {
  /* The message for `failures` consecutive failures, the last for `cause`. */
  public static readonly textFor = (failures: number, cause: string): string =>
    `Claude Code token refresh has failed ${failures} times in a row (${cause}). Check your network connection and that Claude Code's credentials can be read; the plugin keeps retrying.`
}

export default ClaudeAuthRefreshExhaustedError
