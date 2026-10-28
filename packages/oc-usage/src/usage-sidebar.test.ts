import { Effect, Option, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import UsageUnavailable from "./usage-unavailable-error.ts"
import { createSignal } from "solid-js"
import sidebar from "./usage-sidebar.test-support.ts"
import usageReport from "./usage-report.ts"

const FAILED = Effect.fail(UsageUnavailable.make({ message: "RPC failed." })),
  FIRST = 0,
  FUTURE_RESET = 90_000,
  PERCENT_USED = 34,
  REPORT = usageReport.UsageReport.make({
    subscriptions: [
      {
        state: usageReport.Measured.make({
          measuredAt: FIRST,
          plan: Option.some("Max"),
          problem: Option.none(),
          windows: [
            {
              label: "5-hour",
              resetsAt: Option.some(FUTURE_RESET),
              usedPercent: Option.some(PERCENT_USED),
            },
          ],
        }),
        title: "Claude",
      },
    ],
  }),
  SUCCESS = Effect.succeed(REPORT)

describe("mounted sidebar polling", () => {
  it.effect(
    "refreshes after a minute and dates a retained measurement after an RPC failure",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const answer =
            yield* Ref.make<
              Effect.Effect<
                typeof usageReport.UsageReport.Type,
                UsageUnavailable
              >
            >(SUCCESS),
          fetch = Ref.get(answer).pipe(Effect.flatMap((response) => response)),
          frame = yield* sidebar.section(fetch, () => "same-sign-in")

        expect(yield* frame()).toStrictEqual([
          "Usage",
          "Claude · Max",
          "5-hour   34%  1m",
        ])
        yield* Ref.set(answer, FAILED)
        yield* TestClock.adjust("1 minute")
        expect(yield* frame()).toStrictEqual([
          "Usage",
          "Claude · Max",
          "5-hour   34%  <1m",
          "Measured 1m ago.",
          "RPC failed.",
        ])
      }).pipe(Effect.scoped),
  )
})

describe("mounted sidebar generation", () => {
  it.effect(
    "withdraws the previous report before a new sign-in's failed request",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const answer =
            yield* Ref.make<
              Effect.Effect<
                typeof usageReport.UsageReport.Type,
                UsageUnavailable
              >
            >(SUCCESS),
          fetch = Ref.get(answer).pipe(Effect.flatMap((response) => response)),
          [stamp, setStamp] = createSignal("old-sign-in"),
          view = yield* sidebar.section(fetch, stamp)

        expect(yield* view()).toStrictEqual([
          "Usage",
          "Claude · Max",
          "5-hour   34%  1m",
        ])
        yield* Ref.set(answer, FAILED)
        setStamp("new-sign-in")
        expect(yield* view()).toStrictEqual(["Usage", "RPC failed."])
      }).pipe(Effect.scoped),
  )
})
