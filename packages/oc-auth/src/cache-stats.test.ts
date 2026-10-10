import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import cache from "./cache-stats.ts"

type TokenUsage = typeof cache.cacheStats extends (
  tokens?: infer Tokens,
) => object
  ? Tokens
  : never

const COMPACT_HUNDREDS = 950,
  COMPACT_MILLIONS = 1_234_567,
  COMPACT_THOUSANDS = 45_200,
  NEWEST_HIT_RATE = 0.99,
  ONE_ASSERTION = 1,
  RATE = 0.8734,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  /* A usage record with these prompt counts and some output and reasoning. */
  usage = (counts: {
    readonly input: number
    readonly read: number
    readonly write: number
  }): TokenUsage => ({
    cache: { read: counts.read, write: counts.write },
    input: counts.input,
    output: 50,
    reasoning: 10,
  })

describe("cacheStats", () => {
  it.effect("counts cache reads against every prompt token", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const stats = yield* Effect.fromOption(
        cache.cacheStats(usage({ input: 100, read: 800, write: 100 })),
      )

      expect(stats).toStrictEqual({
        hitRate: 0.8,
        missRate: 0.19999999999999996,
        prompt: 1000,
        read: 800,
        uncached: 100,
        write: 100,
      })
    }),
  )

  it.effect("ignores output and reasoning tokens", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const stats = yield* Effect.fromOption(
        cache.cacheStats({
          cache: { read: 0, write: 0 },
          input: 10,
          output: 9999,
          reasoning: 9999,
        }),
      )

      expect(stats).toMatchObject({ hitRate: 0, missRate: 1, prompt: 10 })
    }),
  )
})

describe("cacheStats without a prompt", () => {
  it.effect("reports nothing without prompt tokens", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)

      const empty = cache.cacheStats(usage({ input: 0, read: 0, write: 0 })),
        missing = cache.cacheStats()

      expect(Option.isNone(missing)).toBe(true)
      expect(Option.isNone(empty)).toBe(true)
    }),
  )

  it.effect("treats negative and non-finite counts as zero", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const stats = yield* Effect.fromOption(
        cache.cacheStats(usage({ input: Number.NaN, read: 50, write: -5 })),
      )

      expect(stats).toMatchObject({ hitRate: 1, prompt: 50 })
    }),
  )
})

describe("lastRequestStats", () => {
  it.effect("uses the newest assistant message that reported usage", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const stats = yield* Effect.fromOption(
        cache.lastRequestStats([
          {
            tokens: usage({ input: 100, read: 0, write: 900 }),
            type: "assistant",
          },
          { type: "user" },
          {
            tokens: usage({ input: 10, read: 990, write: 0 }),
            type: "assistant",
          },
          { type: "assistant" },
          {
            tokens: usage({ input: 500, read: 0, write: 0 }),
            type: "compaction",
          },
        ]),
      )

      expect(stats.hitRate).toBe(NEWEST_HIT_RATE)
    }),
  )

  it.effect("reports nothing before the first response", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)

      const missing = cache.lastRequestStats(),
        unanswered = cache.lastRequestStats([{ type: "user" }])

      expect(Option.isNone(missing)).toBe(true)
      expect(Option.isNone(unanswered)).toBe(true)
    }),
  )
})

describe("formatting", () => {
  it.effect("formats token counts compactly", () =>
    Effect.sync(() => {
      expect.assertions(THREE_ASSERTIONS)

      expect(cache.formatTokens(COMPACT_HUNDREDS)).toBe("950")
      expect(cache.formatTokens(COMPACT_THOUSANDS)).toBe("45.2K")
      expect(cache.formatTokens(COMPACT_MILLIONS)).toBe("1.2M")
    }),
  )

  it.effect("formats rates and the breakdown", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const stats = yield* Effect.fromOption(
        cache.cacheStats(
          usage({ input: 30_000, read: 1_200_000, write: 45_200 }),
        ),
      )

      expect(cache.formatPercent(RATE)).toBe("87.3%")
      expect(cache.formatRates(stats)).toBe("94.1% hit · 5.9% miss")
      expect(cache.formatBreakdown(stats)).toBe(
        "1.2M read · 45.2K write · 30K uncached",
      )
    }),
  )
})
