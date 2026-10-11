import { Effect, Layer, Option, Random } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import RefreshBackoff from "./refresh-backoff.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof backoffAt>> | Scope.Scope
  >
}

const BOTTOM = 0,
  DEFAULT_BASE_MS = 15_000,
  FIVE_ASSERTIONS = 5,
  HINT_MS = 25_000,
  NONE = 0,
  NOW = 1_000_000,
  ONCE = 1,
  ONE_ASSERTION = 1,
  ONE_MS = 1,
  OVERRIDDEN_BASE_MS = 1000,
  OVERRIDE_OPTIONS = { refreshCooldownMs: OVERRIDDEN_BASE_MS },
  SRC = "Claude Code-credentials",
  THREE_ASSERTIONS = 3,
  TOP = 1,
  TWICE = 2,
  TWO_ASSERTIONS = 2,
  /*
   * A fresh tracker whose jitter is always `jitter`, with the plugin's
   * `options`, and the test clock at `NOW`.
   */
  backoffAt = (
    jitter: number,
    options: Plugin.Context["options"] = {},
  ): Layer.Layer<RefreshBackoff, PluginOptionsError> => {
    const backoff = RefreshBackoff.layer.pipe(
        Layer.provide(PluginOptions.layer(options)),
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
  test.layer(backoffAt(BOTTOM))((it: Tests) => {
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
        }),
    )
  })

  test.layer(backoffAt(BOTTOM))((it: Tests) => {
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
        }),
    )
  })
})

test.layer(backoffAt(BOTTOM))("refresh failure latch", (it: Tests) => {
  it.effect("records a terminal failure without a cooldown", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const backoff = yield* RefreshBackoff

      yield* backoff.noteTerminal(SRC)

      expect(yield* backoff.failureKind(SRC)).toStrictEqual(
        Option.some("terminal"),
      )
      expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(NONE)
    }),
  )
})

describe("refresh cooldown reset", () => {
  test.layer(backoffAt(BOTTOM))((it: Tests) => {
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
          expect(yield* backoff.noteTransient(SRC, Option.none())).toBe(
            firstEver,
          )
        }),
    )
  })

  test.layer(backoffAt(BOTTOM))((it: Tests) => {
    it.effect(
      "counts consecutive transients until the outcome is cleared",
      () =>
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
        }),
    )
  })
})

describe("refresh cooldown length", () => {
  test.layer(backoffAt(TOP))((it: Tests) => {
    it.effect("ends the cooldown exactly at its deadline", () =>
      Effect.gen(function* run() {
        expect.assertions(THREE_ASSERTIONS)

        const backoff = yield* RefreshBackoff,
          cooldown = yield* backoff.noteTransient(SRC, Option.none())

        expect(cooldown).toBe(DEFAULT_BASE_MS)

        yield* TestClock.adjust(DEFAULT_BASE_MS - ONE_MS)

        expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(ONE_MS)

        yield* TestClock.adjust(ONE_MS)

        // A request at the deadline may refresh.
        expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(NONE)
      }),
    )
  })

  test.layer(backoffAt(BOTTOM))((it: Tests) => {
    it.effect("honors a retry-after hint when setting the cooldown", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const backoff = yield* RefreshBackoff,
          cooldown = yield* backoff.noteTransient(SRC, Option.some(HINT_MS))

        expect(cooldown).toBe(HINT_MS)
        expect(yield* backoff.cooldownRemainingMs(SRC)).toBe(HINT_MS)
      }),
    )
  })

  test.layer(backoffAt(TOP, OVERRIDE_OPTIONS))((it: Tests) => {
    it.effect("takes its base cooldown from the refreshCooldownMs option", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const backoff = yield* RefreshBackoff,
          cooldown = yield* backoff.noteTransient(SRC, Option.none())

        expect(cooldown).toBe(OVERRIDDEN_BASE_MS)
      }),
    )
  })
})
