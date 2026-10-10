import { Option, Schema } from "effect"

/*
 * Transient-vs-terminal classification and the backoff schedule for OAuth
 * token refreshes.
 *
 * The token endpoint (`platform.claude.com/v1/oauth/token`) may rate-limit
 * refresh requests with HTTP 429 `rate_limit_error`. That is transient,
 * because the refresh token is still valid. This module tells a transient
 * failure apart from a genuinely dead refresh token (`invalid_grant`), and
 * computes a cooldown so a rate-limited account is not re-hit until the
 * window has plausibly cleared.
 */

/** Whether a refresh failure says anything against the refresh token itself. */
type RefreshFailureKind = "terminal" | "transient"

/** What one backoff computation depends on. */
interface BackoffInputs {
  /** Base cooldown after the first transient failure. */
  readonly baseMs: number
  /** Consecutive transient failures, this one included. */
  readonly consecutive: number
  /** A random fraction in [0, 1]: 0 is the bottom of the jitter band. */
  readonly jitter: number
  /** The endpoint's `retry-after` hint, when it sent one. */
  readonly retryAfterMs: Option.Option<number>
}

const DOUBLING = 2,
  FIRST_FAILURE = 1,
  JITTER_FLOOR = 0.5,
  JITTER_SPAN = 0.5,
  /*
   * Consecutive transient failures after which the user is told. Unknown
   * OAuth errors are classified transient so a recoverable blip never
   * demands re-authentication. Without the ceiling, a permanent failure with
   * an unfamiliar code, such as a lapsed subscription, would retry behind a
   * synthetic 429 and never reach the user. Retries continue past the
   * ceiling. With the default base cooldown it is reached after about eight
   * minutes at worst (15 + 30 + 7 × 60 seconds), sooner with jitter.
   */
  MAX_CONSECUTIVE_TRANSIENT = 10,
  /** Hard ceiling for a single cooldown, regardless of consecutive failures. */
  MAX_COOLDOWN_MS = 60_000,
  NO_WAIT = 0,
  /*
   * OAuth token-endpoint error codes that mean the refresh token itself is no
   * longer usable. Everything else is transient, including rate limits, 5xx
   * responses, network errors, and unknown codes, so a recoverable blip never
   * becomes a hard "re-authenticate" error.
   */
  TerminalOAuthError = Schema.Literals([
    "invalid_grant",
    "invalid_client",
    "unauthorized_client",
    "unsupported_grant_type",
    "invalid_scope",
  ]),
  /*
   * Delay before the next refresh attempt. An explicit `retry-after` from the
   * endpoint wins (still clamped to `MAX_COOLDOWN_MS`); otherwise an
   * exponential schedule (base · 2^(n-1), capped) with jitter in the
   * [50%, 100%] band to desynchronize refreshes.
   */
  backoffMs = (inputs: BackoffInputs): number => {
    const exponent = Math.max(NO_WAIT, inputs.consecutive - FIRST_FAILURE),
      scheduled = Math.min(
        MAX_COOLDOWN_MS,
        inputs.baseMs * DOUBLING ** exponent,
      )

    return inputs.retryAfterMs.pipe(
      Option.filter((hint) => hint > NO_WAIT),
      Option.match({
        onNone: () =>
          Math.round(scheduled * (JITTER_FLOOR + inputs.jitter * JITTER_SPAN)),
        /*
         * Honor the server's hint, but keep it under the documented cap so a
         * large `Retry-After` (e.g. an hour-long quota reset) can't pin every
         * request to the full wait budget for that whole window.
         */
        onSome: (hint) => Math.min(MAX_COOLDOWN_MS, hint),
      }),
    )
  },
  // A failure is terminal only when its OAuth error code says so.
  classify = (oauthError: Option.Option<string>): RefreshFailureKind => {
    if (Option.exists(oauthError, Schema.is(TerminalOAuthError))) {
      return "terminal"
    }

    return "transient"
  }

/** The refresh backoff policy: failure classification and cooldown lengths. */
export default Object.freeze({
  MAX_CONSECUTIVE_TRANSIENT,
  MAX_COOLDOWN_MS,
  backoffMs,
  classify,
})
