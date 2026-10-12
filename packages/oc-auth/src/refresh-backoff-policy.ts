import { Option, Schema } from "effect"

/*
 * The token endpoint (`platform.claude.com/v1/oauth/token`) may rate-limit
 * refreshes with HTTP 429 `rate_limit_error`, which leaves the refresh token
 * valid. This module tells such a transient failure from a terminal one,
 * marked by an OAuth error code in `TerminalOAuthError`, and picks a cooldown
 * so a rate-limited account is not asked again before the limit is likely
 * to have reset.
 */

/** Whether a refresh failure is final for its credential generation. */
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
   * OAuth errors count as transient, so without this ceiling a permanent
   * failure with an unfamiliar code, such as a lapsed subscription, would
   * retry behind a synthetic 429 and never reach the user. Retries go on
   * past the ceiling. It counts failures, not time: with the default base
   * cooldown, the cooldowns before it add up to about eight minutes at worst
   * (15 + 30 + 7 × 60 seconds), less with jitter, but the refresh requests,
   * `retry-after` hints, and gaps between the model requests that trigger
   * refreshes add to the wait.
   */
  MAX_CONSECUTIVE_TRANSIENT = 10,
  /** Hard ceiling for a single cooldown, regardless of consecutive failures. */
  MAX_COOLDOWN_MS = 60_000,
  NO_WAIT = 0,
  /*
   * OAuth token-endpoint error codes (RFC 6749, section 5.2) that end
   * refreshing until the user signs in again, because sending the same
   * request again gets the same answer. Not each one rejects the refresh
   * token: `invalid_client` and `unsupported_grant_type` reject the client
   * and the request. Everything else is transient, including rate limits,
   * 5xx responses, network errors, `invalid_request`, and unknown codes, so a
   * recoverable blip never becomes a hard "re-authenticate" error.
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
   * endpoint wins, capped at `MAX_COOLDOWN_MS`, so an hour-long quota reset
   * does not turn every request away for that hour. Otherwise the delay
   * doubles from the base with each failure, up to the cap, with jitter in
   * the [50%, 100%] band so processes do not refresh in step.
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
        onSome: (hint) => Math.min(MAX_COOLDOWN_MS, hint),
      }),
    )
  },
  /* A failure is terminal only when its OAuth error code says so. */
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
