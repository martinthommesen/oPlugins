import type { Duration, Scope } from "effect"
import { Effect, Fiber, Layer, Match, Option, Ref, Schema } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import HostScript from "./host-tracker.test-support.ts"
import { TestClock } from "effect/testing"
import UsageTracker from "./usage-tracker.ts"
import type { Vitest } from "@effect/vitest"
import type usageReport from "./usage-report.ts"

interface Scenario {
  readonly index: number
  readonly resolver: "codexResolver" | "resolver"
  readonly title: string
  readonly wait: Duration.Input
}

interface Tests {
  readonly effect: Vitest.Test<
    CapturedLogs | HostScript | Scope.Scope | UsageTracker
  >
}

const CAPTURED = HostScript.layer.pipe(Layer.provideMerge(CapturedLogs.layer)),
  FIRST = 0,
  OLD_PERCENT = 10,
  SECOND = 1,
  TOKEN_CASES = [
    { index: FIRST, resolver: "resolver", title: "Claude", wait: "3 minutes" },
    {
      index: SECOND,
      resolver: "codexResolver",
      title: "Codex",
      wait: "1 minute",
    },
  ] satisfies readonly Scenario[],
  allStates = UsageTracker.pipe(
    Effect.flatMap((tracker) => tracker.report),
    Effect.map((report) =>
      report.subscriptions.map((subscription) => subscription.state),
    ),
  ),
  encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  measuredPercent = (
    state: typeof usageReport.State.Type,
  ): Option.Option<number> =>
    Match.value(state).pipe(
      Match.tag("Measured", (measured) =>
        Option.fromUndefinedOr(measured.windows[FIRST]).pipe(
          Option.flatMap((window) => window.usedPercent),
        ),
      ),
      Match.orElse(() => Option.none<number>()),
    ),
  namesOf = (
    values: readonly (typeof usageReport.State.Type)[],
  ): readonly string[] =>
    values.map((state) =>
      Match.valueTags(state, {
        Disconnected: () => "disconnected",
        Failed: () => "failed",
        Ineligible: () => "ineligible",
        Measured: () => "measured",
      }),
    ),
  percentAt = (
    index: number,
  ): Effect.Effect<Option.Option<number>, never, UsageTracker> =>
    allStates.pipe(
      Effect.map((values: readonly (typeof usageReport.State.Type)[]) =>
        Option.fromUndefinedOr(values[index]).pipe(
          Option.flatMap((state) => measuredPercent(state)),
        ),
      ),
    ),
  stateNames = allStates.pipe(
    Effect.map((values: readonly (typeof usageReport.State.Type)[]) =>
      namesOf(values),
    ),
  )

describe.each(TOKEN_CASES)(
  "replacing the $title credential",
  (scenario: Scenario) => {
    test.layer(CAPTURED)((it: Tests) => {
      it.effect(
        "withdraws A when B preserves its ID, label and metadata, including B's failed refresh",
        () =>
          Effect.gen(function* run() {
            expect.hasAssertions()

            const replacement = Effect.succeed(HostScript.oauth("synthetic-b")),
              script = yield* HostScript

            expect(yield* percentAt(scenario.index)).toStrictEqual(
              Option.some(OLD_PERCENT),
            )
            yield* Ref.set(script[scenario.resolver], replacement)
            expect(yield* percentAt(scenario.index)).toStrictEqual(
              Option.none(),
            )
            yield* Ref.set(script.failed, true)
            yield* TestClock.adjust(scenario.wait)
            expect(yield* percentAt(scenario.index)).toStrictEqual(
              Option.none(),
            )
          }),
      )
    })
  },
)

describe("resolution deadline", () => {
  test.layer(CAPTURED)((it: Tests) => {
    it.effect(
      "bounds renewal without exposing an unverified old measurement or losing the healthy subscription",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const script = yield* HostScript,
            waiting = yield* allStates.pipe(
              Effect.andThen(Ref.set(script.resolver, Effect.never)),
              Effect.andThen(Effect.forkChild(allStates)),
            )

          yield* TestClock.adjust("45 seconds")
          expect(namesOf(yield* Fiber.join(waiting))).toStrictEqual([
            "failed",
            "measured",
          ])
          yield* Ref.set(
            script.resolver,
            Effect.succeed(HostScript.oauth("synthetic-a")),
          )
          expect((yield* stateNames)[SECOND]).toBe("measured")
        }),
    )
  })
})

describe("resolver defect", () => {
  test.layer(CAPTURED)((it: Tests) => {
    it.effect(
      "sanitizes defects in reports and logs while preserving the healthy subscription",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const logs = yield* CapturedLogs,
            script = yield* HostScript

          yield* Ref.set(
            script.resolver,
            Effect.die(new Error("PRIVATE_SENTINEL")),
          )
          expect(yield* stateNames).toStrictEqual(["failed", "measured"])
          expect(
            yield* allStates.pipe(Effect.flatMap(encodeJson)),
          ).not.toContain("PRIVATE_SENTINEL")
          expect(
            yield* logs.records.pipe(Effect.flatMap(encodeJson)),
          ).not.toContain("PRIVATE_SENTINEL")
        }),
    )
  })
})
