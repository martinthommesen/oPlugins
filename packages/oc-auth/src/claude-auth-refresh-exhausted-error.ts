import { Schema } from "effect"

/**
 * Refreshing kept failing for reasons that say nothing against the refresh
 * token itself: the network, the token endpoint, or the credential store.
 * Unlike `ClaudeAuthTerminalError` nothing is latched; the next attempt
 * after the cooldown goes out as usual, so recovery needs no restart.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ClaudeAuthRefreshExhaustedError extends Schema.TaggedError<ClaudeAuthRefreshExhaustedError>()(
  "ClaudeAuthRefreshExhaustedError",
  { message: Schema.String },
) {
  /* The message for `failures` consecutive failures, the last for `cause`. */
  public static readonly textFor = (failures: number, cause: string): string =>
    `Claude Code token refresh has failed ${failures} times in a row (${cause}). Check your network connection; the plugin keeps retrying.`
}

export default ClaudeAuthRefreshExhaustedError
