import { Array as Arr, Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import policy from "./refresh-backoff-policy.ts"

const BASE_MS = 15_000,
  BOTTOM = 0,
  CAP_MS = 60_000,
  DOUBLE_BASE_MS = 30_000,
  FIFTH = 5,
  FIRST = 1,
  FOUR_ASSERTIONS = 4,
  HALF_BASE_MS = 7500,
  HINT_MS = 12_345,
  HOUR_MS = 3_600_000,
  HUGE_STREAK = 99,
  ONE_ASSERTION = 1,
  SECOND = 2,
  SHORT_HINT_MS = 10_000,
  THREE_ASSERTIONS = 3,
  TOP = 1,
  TWO_ASSERTIONS = 2,
  /* The cooldown for a first failure the endpoint sent `retryAfterMs` with. */
  hinted = (retryAfterMs: number, jitter: number): number =>
    policy.backoffMs({
      baseMs: BASE_MS,
      consecutive: FIRST,
      jitter,
      retryAfterMs: Option.some(retryAfterMs),
    }),
  /* The cooldown for a streak of `consecutive` failures at `jitter`, without a hint. */
  scheduled = (consecutive: number, jitter: number): number =>
    policy.backoffMs({
      baseMs: BASE_MS,
      consecutive,
      jitter,
      retryAfterMs: Option.none(),
    }),
  /* The cooldowns for the first five failures in a row at `jitter`. */
  streak = (jitter: number): readonly number[] =>
    Arr.range(FIRST, FIFTH).map((count) => scheduled(count, jitter))

describe("refresh failure classification", () => {
  it.effect(
    "treats rate limiting and errors without an OAuth code as transient",
    () =>
      Effect.sync(() => {
        expect.assertions(TWO_ASSERTIONS)

        expect(policy.classify(Option.some("rate_limit_error"))).toBe(
          "transient",
        )
        // 5xx, network failures, and anything else without a body code.
        expect(policy.classify(Option.none())).toBe("transient")
      }),
  )

  it.effect("treats a revoked or invalid refresh token as terminal", () =>
    Effect.sync(() => {
      expect.assertions(FOUR_ASSERTIONS)

      expect(policy.classify(Option.some("invalid_grant"))).toBe("terminal")
      expect(policy.classify(Option.some("invalid_client"))).toBe("terminal")
      expect(policy.classify(Option.some("unauthorized_client"))).toBe(
        "terminal",
      )
      expect(policy.classify(Option.some("unsupported_grant_type"))).toBe(
        "terminal",
      )
    }),
  )

  it.effect("treats an unknown OAuth error code as transient", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)

      expect(policy.classify(Option.some("something_new"))).toBe("transient")
    }),
  )
})

describe("refresh backoff with a retry-after hint", () => {
  it.effect(
    "honors an explicit retry-after over the exponential schedule",
    () =>
      Effect.sync(() => {
        expect.assertions(ONE_ASSERTION)

        expect(hinted(HINT_MS, BOTTOM)).toBe(HINT_MS)
      }),
  )

  it.effect("clamps a large retry-after to the cap", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)

      // A server sending Retry-After: 3600 must not pin the cooldown to an hour.
      expect(hinted(HOUR_MS, BOTTOM)).toBe(policy.MAX_COOLDOWN_MS)
    }),
  )

  it.effect("passes a short retry-after through and clamps a long one", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)

      expect(hinted(SHORT_HINT_MS, TOP)).toBe(SHORT_HINT_MS)
      expect(hinted(HOUR_MS, TOP)).toBe(CAP_MS)
    }),
  )
})

describe("refresh backoff schedule", () => {
  it.effect("grows exponentially with consecutive failures and is capped", () =>
    Effect.sync(() => {
      expect.assertions(THREE_ASSERTIONS)

      // The second failure backs off longer.
      expect(scheduled(SECOND, BOTTOM)).toBeGreaterThan(
        scheduled(FIRST, BOTTOM),
      )
      // The backoff is capped.
      expect(scheduled(HUGE_STREAK, BOTTOM)).toBeLessThanOrEqual(
        policy.MAX_COOLDOWN_MS,
      )
      // The first backoff is near the base floor.
      expect(scheduled(FIRST, BOTTOM)).toBeGreaterThanOrEqual(BASE_MS / SECOND)
    }),
  )

  it.effect(
    "applies jitter within the [50%, 100%] band of the scheduled delay",
    () =>
      Effect.sync(() => {
        expect.assertions(THREE_ASSERTIONS)

        expect(scheduled(FIRST, TOP)).toBeGreaterThan(scheduled(FIRST, BOTTOM))
        expect(scheduled(FIRST, BOTTOM)).toBeGreaterThanOrEqual(
          BASE_MS / SECOND,
        )
        expect(scheduled(FIRST, TOP)).toBeLessThanOrEqual(BASE_MS)
      }),
  )
})

describe("refresh backoff schedule at the default base", () => {
  it.effect("doubles from the base and stops at the cap, at full jitter", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)

      // Base 15s * 2^(n-1) = 15s, 30s, 60s, then 120s and 240s clamped to 60s.
      expect(streak(TOP)).toStrictEqual([
        BASE_MS,
        DOUBLE_BASE_MS,
        CAP_MS,
        CAP_MS,
        CAP_MS,
      ])
    }),
  )

  it.effect("halves every step at the bottom of the jitter band", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)

      expect(streak(BOTTOM)).toStrictEqual([
        HALF_BASE_MS,
        BASE_MS,
        DOUBLE_BASE_MS,
        DOUBLE_BASE_MS,
        DOUBLE_BASE_MS,
      ])
    }),
  )
})
