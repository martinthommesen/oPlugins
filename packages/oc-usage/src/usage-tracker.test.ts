import type { Duration, Scope } from "effect"
import { Effect, Option } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import Script from "./tracker.test-support.ts"
import { TestClock } from "effect/testing"
import UsageMeter from "./usage-meter.ts"
import type UsageTracker from "./usage-tracker.ts"
import type { Vitest } from "@effect/vitest"
import claudeUsage from "./claude-usage.ts"
import usageReport from "./usage-report.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Script | Scope.Scope | UsageTracker>
}

const NEVER = 0,
  ONCE = 1,
  START = 0,
  THREE_MINUTES = 180_000,
  THRICE = 3,
  TWICE = 2,
  /* How often the meter asked Anthropic and ChatGPT. */
  counts = Effect.all([Script.countOf("Anthropic"), Script.countOf("ChatGPT")]),
  /* The measurement of `Script.READING` taken at `time`. */
  measuredAt = (time: number): ReturnType<typeof usageReport.Measured.make> =>
    usageReport.Measured.make({
      measuredAt: time,
      plan: Option.none(),
      problem: Option.none(),
      windows: Script.READING.windows,
    }),
  /* Every subscription's state once `elapsed` has passed. */
  statesAfter = (
    elapsed: Duration.Input,
  ): Effect.Effect<
    Effect.Success<typeof Script.states>,
    never,
    Script | UsageTracker
  > => TestClock.adjust(elapsed).pipe(Effect.andThen(Script.states))

describe("a report", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("measures each connected subscription once", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* Script.states).toStrictEqual([
          measuredAt(START),
          measuredAt(START),
        ])
        expect(yield* counts).toStrictEqual([ONCE, ONCE])
      }),
    )
  })

  test.layer(Script.layer)((it: Tests) => {
    it.effect("says how to connect a subscription that isn't", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.connect("anthropic", Effect.succeedNone)

        expect(yield* Script.states).toStrictEqual([
          usageReport.Disconnected.make({ hint: claudeUsage.hint }),
          measuredAt(START),
        ])
        expect(yield* Script.countOf("Anthropic")).toBe(NEVER)
      }),
    )
  })
})

describe("a subscription's interval", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("keeps each measurement until the interval passes", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.states
        yield* statesAfter("59 seconds")

        expect(yield* counts).toStrictEqual([ONCE, ONCE])

        yield* statesAfter("1 second")

        expect(yield* counts).toStrictEqual([ONCE, TWICE])
        expect(yield* statesAfter("2 minutes")).toStrictEqual([
          measuredAt(THREE_MINUTES),
          measuredAt(THREE_MINUTES),
        ])
        expect(yield* counts).toStrictEqual([TWICE, THRICE])
      }),
    )
  })
})

describe("a connection that changes account", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("is measured anew at once", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.states
        yield* Script.connect("anthropic", Script.signedIn("claude-b"))
        yield* Script.states

        expect(yield* counts).toStrictEqual([TWICE, ONCE])
      }),
    )
  })

  test.layer(Script.layer)((it: Tests) => {
    it.effect("never shows the earlier account's measurement", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.states
        yield* Script.connect("anthropic", Script.signedIn("claude-b"))
        yield* Script.answer(
          "Anthropic",
          Effect.succeed(
            UsageMeter.Outcome.Unreachable({ problem: "Anthropic is down." }),
          ),
        )

        expect(yield* Script.states).toStrictEqual([
          usageReport.Failed.make({ problem: "Anthropic is down." }),
          measuredAt(START),
        ])
      }),
    )
  })
})
