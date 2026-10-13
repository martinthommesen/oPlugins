import { Duration, Effect, Option, Redacted } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import HostError from "./host-error.ts"
import type { Scope } from "effect"
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

const ASKED_WAIT_MINUTES = 10,
  /** A host call that failed. */
  FAILED_CALL = HostError.make({
    category: "unknown",
    cause: "host failure",
    operation: "integration.connection.active",
  }),
  FIRST = 0,
  /** A rate-limited answer that asks for ten minutes. */
  LIMITED = UsageMeter.Outcome.Limited({
    problem: "Slow.",
    wait: Duration.minutes(ASKED_WAIT_MINUTES),
  }),
  /** A sign-in that names no ChatGPT account. */
  NAMELESS = Effect.succeedSome({
    accountId: Option.none(),
    token: Redacted.make("opaque"),
  }),
  NEVER = 0,
  /** A connection that holds no OAuth sign-in. */
  NO_ACCESS = Effect.succeedNone,
  SECOND = 1,
  START = 0,
  THRICE = 3,
  TWICE = 2,
  /* The first subscription's state: Claude's. */
  claudeState = Script.states.pipe(Effect.map((states) => states[FIRST])),
  /* The measurement of `Script.READING` taken at the start, with `problem`. */
  measured = (
    problem: Option.Option<string>,
  ): ReturnType<typeof usageReport.Measured.make> =>
    usageReport.Measured.make({
      measuredAt: START,
      plan: Option.none(),
      problem,
      windows: Script.READING.windows,
    }),
  /* Measures Claude once, then lets its interval pass and makes the next request come to `outcome`. */
  thenAnswer = (
    outcome: ReturnType<UsageMeter["Service"]["measure"]>,
  ): Effect.Effect<void, never, Script | UsageTracker> =>
    Script.states.pipe(
      Effect.andThen(TestClock.adjust("3 minutes")),
      Effect.andThen(Script.answer("Anthropic", outcome)),
    )

describe("a failed request after a measurement", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("keeps the measurement, with the problem, when it may pass", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* thenAnswer(
          Effect.succeed(UsageMeter.Outcome.Unreachable({ problem: "Down." })),
        )

        expect(yield* claudeState).toStrictEqual(measured(Option.some("Down.")))
      }),
    )
  })

  test.layer(Script.layer)((it: Tests) => {
    it.effect("withdraws the measurement when the sign-in was refused", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* thenAnswer(
          Effect.succeed(UsageMeter.Outcome.Rejected({ problem: "Refused." })),
        )

        expect(yield* claudeState).toStrictEqual(
          usageReport.Failed.make({ problem: "Refused." }),
        )
      }),
    )
  })
})

describe("a rate-limited request", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("waits as long as the service asks, past the interval", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* thenAnswer(Effect.succeed(LIMITED))
        yield* Script.states
        yield* TestClock.adjust("9 minutes")
        yield* Script.states

        expect(yield* Script.countOf("Anthropic")).toBe(TWICE)

        yield* TestClock.adjust("1 minute")
        yield* Script.states

        expect(yield* Script.countOf("Anthropic")).toBe(THRICE)
      }),
    )
  })
})

describe("a connection that can't be measured", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("is ineligible when it holds no OAuth sign-in", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.connect("anthropic", Script.withAccess("env", NO_ACCESS))

        expect(yield* claudeState).toStrictEqual(
          usageReport.Ineligible.make({ reason: claudeUsage.ineligible }),
        )
      }),
    )
  })

  test.layer(Script.layer)((it: Tests) => {
    it.effect("says when OpenCode couldn't renew its sign-in", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.connect(
          "anthropic",
          Script.withAccess("a", Effect.fail(FAILED_CALL)),
        )

        expect(yield* claudeState).toStrictEqual(
          usageReport.Failed.make({
            problem: "OpenCode couldn't renew the Anthropic sign-in.",
          }),
        )
      }),
    )
  })
})

describe("a request that can't go out", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("says why, and asks nothing", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.connect("openai", Script.withAccess("b", NAMELESS))

        expect((yield* Script.states)[SECOND]).toStrictEqual(
          usageReport.Failed.make({
            problem:
              "The ChatGPT sign-in doesn't name a ChatGPT account. Reconnect OpenAI with /connect.",
          }),
        )
        expect(yield* Script.countOf("ChatGPT")).toBe(NEVER)
      }),
    )
  })
})

describe("a host that can't read one connection", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("fails that subscription alone", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.connect("anthropic", Effect.fail(FAILED_CALL))

        expect(yield* Script.states).toStrictEqual([
          usageReport.Failed.make({
            problem: "OpenCode couldn't read the Anthropic connection.",
          }),
          measured(Option.none()),
        ])
      }),
    )
  })
})
