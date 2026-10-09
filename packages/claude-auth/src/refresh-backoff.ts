/**
 * Transient-vs-terminal classification and per-account backoff for OAuth token
 * refreshes.
 *
 * The token endpoint (`platform.claude.com/v1/oauth/token`) may rate-limit
 * refresh requests with HTTP 429 `rate_limit_error`. That is transient, because
 * the refresh token is still valid. This module tells a transient failure apart
 * from a genuinely dead refresh token (`invalid_grant`), and imposes a
 * cooldown so a rate-limited account is not re-hit until the window has
 * plausibly cleared.
 */

import { positiveIntFromEnv } from "./env.ts"

type RefreshFailureKind = "transient" | "terminal"

/** Base cooldown after the first transient failure (env-overridable). */
export const BASE_COOLDOWN_MS = positiveIntFromEnv(
  "OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS",
  15_000,
)

/** Hard ceiling for a single cooldown, regardless of consecutive failures. */
export const MAX_COOLDOWN_MS = 60_000

/**
 * Consecutive transient failures after which the user is told. Unknown OAuth
 * errors are classified transient so a recoverable blip never demands
 * re-authentication. Without the ceiling, a permanent failure with an
 * unfamiliar code, such as a lapsed subscription, would retry behind a
 * synthetic 429 and never reach the user. Retries continue past the ceiling.
 * With the default base cooldown it is reached after about eight minutes at
 * worst (15 + 30 + 7 × 60 seconds), sooner with jitter.
 */
export const MAX_CONSECUTIVE_TRANSIENT = 10

/**
 * OAuth token-endpoint error codes that mean the refresh token itself is no
 * longer usable. Everything else is transient, including rate limits, 5xx
 * responses, network errors, and unknown codes, so a recoverable blip never
 * becomes a hard "re-authenticate" error.
 */
const TERMINAL_OAUTH_ERRORS = new Set([
  "invalid_grant",
  "invalid_client",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
])

export function classifyRefreshFailure(
  oauthError: string | undefined,
): RefreshFailureKind {
  return oauthError && TERMINAL_OAUTH_ERRORS.has(oauthError)
    ? "terminal"
    : "transient"
}

interface BackoffOptions {
  retryAfterMs?: number
  now?: number
  rng?: () => number
}

/**
 * Delay before the next refresh attempt. An explicit `retry-after` from the
 * endpoint wins (still clamped to `MAX_COOLDOWN_MS`); otherwise an
 * exponential schedule (base · 2^(n-1), capped) with jitter in the
 * [50%, 100%] band to desynchronize refreshes.
 */
export function computeBackoffMs(
  consecutive: number,
  opts: BackoffOptions = {},
): number {
  if (opts.retryAfterMs !== undefined && opts.retryAfterMs > 0) {
    // Honor the server's hint, but keep it under the documented cap so a large
    // `Retry-After` (e.g. an hour-long quota reset) can't pin every request to
    // the full wait budget for that whole window.
    return Math.min(MAX_COOLDOWN_MS, opts.retryAfterMs)
  }
  const rng = opts.rng ?? Math.random
  const exponent = Math.max(0, consecutive - 1)
  const scheduled = Math.min(MAX_COOLDOWN_MS, BASE_COOLDOWN_MS * 2 ** exponent)
  const jitterFactor = 0.5 + rng() * 0.5
  return Math.round(scheduled * jitterFactor)
}

/**
 * What is known about one key. Transient state is kept per source and
 * terminal state per credential generation, so the two never share a key in
 * practice. With one map they cannot hold conflicting state for a key anyway.
 */
type BackoffState =
  | { kind: "transient"; until: number; consecutive: number }
  | { kind: "terminal" }

const states = new Map<string, BackoffState>()

function transientState(source: string) {
  const state = states.get(source)
  return state?.kind === "transient" ? state : undefined
}

/**
 * Record a transient refresh failure for `source` and return the cooldown
 * duration applied. The cooldown escalates with consecutive transient
 * failures and is exposed via {@link cooldownRemainingMs}.
 */
export function noteRefreshTransient(
  source: string,
  opts: BackoffOptions = {},
): number {
  const now = opts.now ?? Date.now()
  const consecutive = (transientState(source)?.consecutive ?? 0) + 1
  const ms = computeBackoffMs(consecutive, opts)
  states.set(source, { kind: "transient", until: now + ms, consecutive })
  return ms
}

/** Record a terminal refresh failure (dead refresh token). No cooldown. */
export function noteRefreshTerminal(source: string): void {
  states.set(source, { kind: "terminal" })
}

/** Clear all backoff state for `source` after a successful refresh/adopt. */
export function clearRefreshOutcome(source: string): void {
  states.delete(source)
}

/** Consecutive transient failures recorded for `source`. */
export function transientFailureCount(source: string): number {
  return transientState(source)?.consecutive ?? 0
}

/** How long the cooldown for `source` has left to run, or 0 when none. */
export function cooldownRemainingMs(
  source: string,
  now: number = Date.now(),
): number {
  return Math.max(0, (transientState(source)?.until ?? now) - now)
}

export function getRefreshFailureKind(
  source: string,
): RefreshFailureKind | null {
  return states.get(source)?.kind ?? null
}

/** For tests: drop all in-memory backoff state. */
export function resetRefreshBackoffState(): void {
  states.clear()
}
