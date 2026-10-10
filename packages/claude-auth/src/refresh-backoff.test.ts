import { Effect, Layer, Option, Random } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { Config } from "effect"
import RefreshBackoff from "./refresh-backoff.ts"
import { TestClock } from "effect/testing"
import testEnvironment from "./test-environment.test-support.ts"

const BOTTOM = 0,
  DEFAULT_BASE_MS = 15_000,
  DEFAULT_VARIABLES = { HOME: "/nonexistent-home" },
  FIVE_ASSERTIONS = 5,
  HINT_MS = 25_000,
  NONE = 0,
  NOW = 1_000_000,
  ONCE = 1,
  ONE_ASSERTION = 1,
  ONE_MS = 1,
  OVERRIDDEN_BASE_MS = 1000,
  OVERRIDE_VARIABLES = {
    HOME: "/nonexistent-home",
    OPENCODE_CLAUDE_AUTH_REFRESH_COOLDOWN_MS: String(OVERRIDDEN_BASE_MS),
  },
  SRC = "Claude Code-credentials",
  THREE_ASSERTIONS = 3,
  TOP = 1,
  TWICE = 2,
  TWO_ASSERTIONS = 2,
  /*
   * A fresh tracker whose jitter is always `jitter`, reading `variables` as
   * its environment, with the test clock at `NOW`.
   */
  backoffAt = (
    jitter: number,
    variables: Readonly<Record<string, string>> = DEFAULT_VARIABLES,
  ): Layer.Layer<RefreshBackoff, Config.ConfigError> => {
    const backoff = RefreshBackoff.layer.pipe(
        Layer.provide(testEnvironment(variables)),
      ),
      random = Layer.succeed(Random.Random, {
        nextDoubleUnsafe: () => jitter,
        nextIntUnsafe: () => NONE,
      })

    return Layer.mergeAll(
      backoff,
      random,
      Layer.effectDiscard(TestClock.setTime(NOW)),
    )
  }

describe("refresh cooldown", () => {
  it.effect(
    "activates a cooldown on a transient failure and reports the failure kind",
    () =>
      Effect.gen(function* run() {
        expect.assertions(FIVE_ASSERTIONS)

        const backoff = yield* RefreshBackoff,
          ms = yield* backoff.noteTransient(SRC, Option.none())

        expect(ms).toBeGreaterThan(NONE)
        expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(ms)

        yield* TestClock.adjust(ONE_MS)

        expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(ms - ONE_MS)

        yield* TestClock.adjust(ms)

        expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(NONE)
        expect(yield* backoff.failureKind(SRC)).toStrictEqual(
          Option.some("transient"),
        )
      }).pipe(Effect.provide(backoffAt(BOTTOM))),
  )

  it.effect(
    "escalates the cooldown across consecutive transient failures",
    () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const backoff = yield* RefreshBackoff,
          first = yield* backoff.noteTransient(SRC, Option.none()),
          second = yield* backoff.noteTransient(SRC, Option.none())

        // Consecutive transients back off further.
        expect(second).toBeGreaterThan(first)
      }).pipe(Effect.provide(backoffAt(BOTTOM))),
  )
})

describe("refresh failure latch", () => {
  it.effect("records a terminal failure without a cooldown", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const backoff = yield* RefreshBackoff

      yield* backoff.noteTerminal(SRC)

      expect(yield* backoff.failureKind(SRC)).toStrictEqual(
        Option.some("terminal"),
      )
      expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(NONE)
    }).pipe(Effect.provide(backoffAt(BOTTOM))),
  )
})

describe("refresh cooldown reset", () => {
  it.effect(
    "clears cooldown, consecutive count, and failure kind on success",
    () =>
      Effect.gen(function* run() {
        expect.assertions(THREE_ASSERTIONS)

        const backoff = yield* RefreshBackoff,
          firstEver = yield* backoff.noteTransient(SRC, Option.none())

        yield* backoff.noteTransient(SRC, Option.none())
        yield* backoff.clear(SRC)
        yield* TestClock.adjust(ONE_MS)

        expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(NONE)
        expect(yield* backoff.failureKind(SRC)).toStrictEqual(Option.none())
        // Consecutive count reset: the next transient starts from the base again.
        expect(yield* backoff.noteTransient(SRC, Option.none())).toBe(firstEver)
      }).pipe(Effect.provide(backoffAt(BOTTOM))),
  )

  it.effect("counts consecutive transients until the outcome is cleared", () =>
    Effect.gen(function* run() {
      expect.assertions(FIVE_ASSERTIONS)

      const backoff = yield* RefreshBackoff,
        noteAndCount = backoff
          .noteTransient(SRC, Option.none())
          .pipe(Effect.andThen(backoff.transientCount(SRC)))

      expect(yield* backoff.transientCount(SRC)).toBe(NONE)
      expect(yield* noteAndCount).toBe(ONCE)
      expect(yield* noteAndCount).toBe(TWICE)

      yield* backoff.clear(SRC)

      expect(yield* backoff.transientCount(SRC)).toBe(NONE)
      // Counting restarts from one.
      expect(yield* noteAndCount).toBe(ONCE)
    }).pipe(Effect.provide(backoffAt(BOTTOM))),
  )
})

describe("refresh cooldown length", () => {
  it.effect("ends the cooldown exactly at its deadline", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const backoff = yield* RefreshBackoff

      expect(yield* backoff.noteTransient(SRC, Option.none())).toBe(
        DEFAULT_BASE_MS,
      )

      yield* TestClock.adjust(DEFAULT_BASE_MS - ONE_MS)

      expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(ONE_MS)

      yield* TestClock.adjust(ONE_MS)

      // A request at the deadline may refresh.
      expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(NONE)
    }).pipe(Effect.provide(backoffAt(TOP))),
  )

  it.effect("honors a retry-after hint when setting the cooldown", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const backoff = yield* RefreshBackoff

      expect(yield* backoff.noteTransient(SRC, Option.some(HINT_MS))).toBe(
        HINT_MS,
      )
      expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(HINT_MS)
    }).pipe(Effect.provide(backoffAt(BOTTOM))),
  )

  it.effect("takes its base cooldown from the environment", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const backoff = yield* RefreshBackoff

      expect(yield* backoff.noteTransient(SRC, Option.none())).toBe(
        OVERRIDDEN_BASE_MS,
      )
    }).pipe(Effect.provide(backoffAt(TOP, OVERRIDE_VARIABLES))),
  )
})
