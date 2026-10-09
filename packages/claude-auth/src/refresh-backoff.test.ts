import { describe, it, beforeEach } from "node:test"
import assert from "node:assert/strict"
import {
  classifyRefreshFailure,
  computeBackoffMs,
  noteRefreshTransient,
  noteRefreshTerminal,
  clearRefreshOutcome,
  cooldownRemainingMs,
  getRefreshFailureKind,
  transientFailureCount,
  resetRefreshBackoffState,
  BASE_COOLDOWN_MS,
  MAX_COOLDOWN_MS,
} from "./refresh-backoff.ts"

const SRC = "Claude Code-credentials"

// BASE_COOLDOWN_MS is read from the environment once at import, so literal
// schedule assertions only hold when it is not overridden.
const defaultBase = {
  skip: process.env.OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS !== undefined,
}

describe("refresh-backoff", () => {
  beforeEach(() => resetRefreshBackoffState())

  describe("classifyRefreshFailure", () => {
    it("treats rate limiting and errors without an OAuth code as transient", () => {
      assert.equal(classifyRefreshFailure("rate_limit_error"), "transient")
      // 5xx, network failures, and anything else without a body code.
      assert.equal(classifyRefreshFailure(undefined), "transient")
    })

    it("treats a revoked/invalid refresh token as terminal", () => {
      assert.equal(classifyRefreshFailure("invalid_grant"), "terminal")
      assert.equal(classifyRefreshFailure("invalid_client"), "terminal")
      assert.equal(classifyRefreshFailure("unauthorized_client"), "terminal")
      assert.equal(classifyRefreshFailure("unsupported_grant_type"), "terminal")
    })

    it("defaults unknown 4xx to transient (never a spurious hard error)", () => {
      assert.equal(classifyRefreshFailure("something_new"), "transient")
    })
  })

  describe("computeBackoffMs", () => {
    it("honors an explicit retry-after over the exponential schedule", () => {
      assert.equal(
        computeBackoffMs(1, { retryAfterMs: 12_345, rng: () => 0 }),
        12_345,
      )
    })

    it("clamps a large retry-after to the cap", () => {
      // A server sending Retry-After: 3600 must not pin the cooldown to an hour.
      assert.equal(
        computeBackoffMs(1, { retryAfterMs: 3_600_000, rng: () => 0 }),
        MAX_COOLDOWN_MS,
      )
    })

    it("grows exponentially with consecutive failures and is capped", () => {
      const a = computeBackoffMs(1, { rng: () => 0 })
      const b = computeBackoffMs(2, { rng: () => 0 })
      const c = computeBackoffMs(99, { rng: () => 0 })
      assert.ok(b > a, "second failure backs off longer")
      assert.ok(c <= MAX_COOLDOWN_MS, "backoff is capped")
      assert.ok(a >= BASE_COOLDOWN_MS / 2, "first backoff near the base floor")
    })

    it("applies jitter within the [50%, 100%] band of the scheduled delay", () => {
      const low = computeBackoffMs(1, { rng: () => 0 })
      const high = computeBackoffMs(1, { rng: () => 1 })
      assert.ok(high > low, "rng=1 yields a larger delay than rng=0")
      assert.ok(low >= BASE_COOLDOWN_MS * 0.5)
      assert.ok(high <= BASE_COOLDOWN_MS)
    })

    it(
      "doubles from the base and stops at the cap, at full jitter",
      defaultBase,
      () => {
        // base 15s * 2^(n-1) = 15s, 30s, 60s, then 120s and 240s clamped to 60s.
        assert.deepEqual(
          [1, 2, 3, 4, 5].map((n) => computeBackoffMs(n, { rng: () => 1 })),
          [15_000, 30_000, 60_000, 60_000, 60_000],
        )
      },
    )

    it(
      "halves every step at the bottom of the jitter band",
      defaultBase,
      () => {
        assert.deepEqual(
          [1, 2, 3, 4, 5].map((n) => computeBackoffMs(n, { rng: () => 0 })),
          [7_500, 15_000, 30_000, 30_000, 30_000],
        )
      },
    )

    it("passes a short retry-after through and clamps a long one", () => {
      assert.equal(
        computeBackoffMs(1, { retryAfterMs: 10_000, rng: () => 1 }),
        10_000,
      )
      assert.equal(
        computeBackoffMs(1, { retryAfterMs: 3_600_000, rng: () => 1 }),
        60_000,
      )
    })
  })

  describe("cooldown lifecycle", () => {
    it("activates a cooldown on a transient failure and reports the failure kind", () => {
      const now = 1_000_000
      const ms = noteRefreshTransient(SRC, { now, rng: () => 0 })
      assert.ok(ms > 0)
      assert.equal(cooldownRemainingMs(SRC, now), ms)
      assert.equal(cooldownRemainingMs(SRC, now + 1), ms - 1)
      assert.equal(cooldownRemainingMs(SRC, now + ms + 1), 0)
      assert.equal(getRefreshFailureKind(SRC), "transient")
    })

    it("escalates the cooldown across consecutive transient failures", () => {
      const now = 1_000_000
      const first = noteRefreshTransient(SRC, { now, rng: () => 0 })
      const second = noteRefreshTransient(SRC, { now, rng: () => 0 })
      assert.ok(second > first, "consecutive transients back off further")
    })

    it("records a terminal failure without a cooldown", () => {
      noteRefreshTerminal(SRC)
      assert.equal(getRefreshFailureKind(SRC), "terminal")
      assert.equal(cooldownRemainingMs(SRC, Date.now()), 0)
    })

    it("clears cooldown, consecutive count, and failure kind on success", () => {
      const now = 1_000_000
      noteRefreshTransient(SRC, { now, rng: () => 0 })
      noteRefreshTransient(SRC, { now, rng: () => 0 })
      clearRefreshOutcome(SRC)
      assert.equal(cooldownRemainingMs(SRC, now + 1), 0)
      assert.equal(getRefreshFailureKind(SRC), null)
      // consecutive count reset: the next transient starts from the base again
      const afterReset = noteRefreshTransient(SRC, { now, rng: () => 0 })
      const firstEver = (() => {
        resetRefreshBackoffState()
        return noteRefreshTransient(SRC, { now, rng: () => 0 })
      })()
      assert.equal(afterReset, firstEver)
    })

    it("ends the cooldown exactly at its deadline", defaultBase, () => {
      const now = 1_000_000
      assert.equal(noteRefreshTransient(SRC, { now, rng: () => 1 }), 15_000)
      assert.equal(cooldownRemainingMs(SRC, now + 14_999), 1)
      // A request at the deadline may refresh.
      assert.equal(cooldownRemainingMs(SRC, now + 15_000), 0)
    })

    it("counts consecutive transients until the outcome is cleared", () => {
      const now = 1_000_000
      assert.equal(transientFailureCount(SRC), 0)
      noteRefreshTransient(SRC, { now, rng: () => 0 })
      assert.equal(transientFailureCount(SRC), 1)
      noteRefreshTransient(SRC, { now, rng: () => 0 })
      assert.equal(transientFailureCount(SRC), 2)
      clearRefreshOutcome(SRC)
      assert.equal(transientFailureCount(SRC), 0)
      noteRefreshTransient(SRC, { now, rng: () => 0 })
      assert.equal(transientFailureCount(SRC), 1, "counting restarts from one")
    })

    it("honors a retry-after hint when setting the cooldown", () => {
      const now = 1_000_000
      const ms = noteRefreshTransient(SRC, {
        now,
        retryAfterMs: 25_000,
        rng: () => 0,
      })
      assert.equal(ms, 25_000)
      assert.equal(cooldownRemainingMs(SRC, now), 25_000)
    })
  })
})
