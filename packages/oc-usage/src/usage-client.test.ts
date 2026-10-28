import { Deferred, Effect, Fiber, Match, Option, Ref, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { TestClock } from "effect/testing"
import UsageRpc from "./usage-rpc.ts"
import type UsageUnavailable from "./usage-unavailable-error.ts"
import support from "./usage-client.test-support.ts"
import usageClient from "./usage-client.ts"
import usageReport from "./usage-report.ts"

type Validation = Awaited<
  ReturnType<(typeof UsageRpc.methods.report.output)["~standard"]["validate"]>
>

type Connection = Parameters<typeof usageClient.report>[typeof FIRST]

interface Deadline {
  readonly method: "report" | "setSidebar" | "sidebar"
  readonly wait: "15 seconds" | "90 seconds"
}

const FIRST = 0,
  NEXT = 1,
  NONE = 0,
  OldSidebar = Schema.Struct({ shown: Schema.Boolean }),
  RESET_AT = 60_000,
  SHARE_USED = 34,
  STATES = [
    usageReport.Disconnected.make({ hint: "Connect." }),
    usageReport.Failed.make({ problem: "Unavailable." }),
    usageReport.Ineligible.make({ reason: "API key." }),
    usageReport.Measured.make({
      measuredAt: FIRST,
      plan: Option.none(),
      problem: Option.none(),
      windows: [
        {
          label: "5-hour",
          resetsAt: Option.none(),
          usedPercent: Option.none(),
        },
      ],
    }),
    usageReport.Measured.make({
      measuredAt: FIRST,
      plan: Option.some("Plus"),
      problem: Option.some("Stale."),
      windows: [
        {
          label: "Weekly",
          resetsAt: Option.some(RESET_AT),
          usedPercent: Option.some(SHARE_USED),
        },
      ],
    }),
  ],
  controls = Effect.all({
    generation: Ref.make(NONE),
    signals: Ref.make<readonly AbortSignal[]>([]),
  }),
  corrupt = { problem: "Run /show-usage on to repair.", shown: false },
  corruptVisibility = Effect.flip(
    usageClient.sidebar(support.answering(corrupt)),
  ),
  encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  malformedReport = Effect.flip(
    usageClient.report(support.answering({ subscriptions: "invalid" })),
  ),
  operationOf = (
    connection: Connection,
    method: Deadline["method"],
  ): Effect.Effect<void, UsageUnavailable> =>
    Match.value(method).pipe(
      Match.when("report", () =>
        usageClient.report(connection).pipe(Effect.asVoid),
      ),
      Match.when("setSidebar", () =>
        usageClient.setSidebar(connection, true).pipe(Effect.asVoid),
      ),
      Match.orElse(() => usageClient.sidebar(connection).pipe(Effect.asVoid)),
    )

describe("the RPC report wire contract", () => {
  it.effect(
    "round-trips every state and present/absent Option values through the portable output",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const report = usageReport.UsageReport.make({
            subscriptions: STATES.map((state) => ({
              state,
              title: "Synthetic",
            })),
          }),
          serialized = yield* Schema.encodeEffect(usageReport.UsageReport)(
            report,
          ),
          validated = yield* Effect.promise((): PromiseLike<Validation> =>
            Promise.resolve(
              UsageRpc.methods.report.output["~standard"].validate(serialized),
            ),
          )

        expect(validated).toHaveProperty("value", serialized)
        expect(
          yield* usageClient.report(support.answering(serialized)),
        ).toStrictEqual(report)
        expect(yield* encodeJson(serialized)).toContain('"usedPercent":null')
      }),
  )

  it.effect(
    "rejects malformed reports instead of trusting the SDK's static type",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* malformedReport).toHaveProperty(
          "message",
          expect.stringContaining("can't read"),
        )
      }),
  )
})

describe("visibility wire compatibility", () => {
  it.effect(
    "accepts old output and exposes a new corrupt-setting recovery problem",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* usageClient.sidebar(support.answering({ shown: true })),
        ).toBe(true)
        expect(yield* corruptVisibility).toHaveProperty(
          "message",
          corrupt.problem,
        )
        expect(Schema.decodeOption(OldSidebar)(corrupt)).toStrictEqual(
          Option.some({ shown: false }),
        )
      }),
  )
})

describe.each([
  { method: "report", wait: "90 seconds" },
  { method: "setSidebar", wait: "15 seconds" },
  { method: "sidebar", wait: "15 seconds" },
] satisfies readonly Deadline[])(
  "the $method RPC deadline",
  (scenario: Deadline) => {
    it.effect("aborts a hung call within its own budget", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const harness = yield* controls,
          subject = support.scripted(Effect.never, harness, scenario.method),
          waiting = yield* Effect.forkChild(
            Effect.flip(operationOf(subject, scenario.method)),
          )

        yield* TestClock.adjust(scenario.wait)
        expect(yield* Fiber.join(waiting)).toHaveProperty(
          "message",
          expect.stringContaining("deadline"),
        )
        expect(
          (yield* Ref.get(harness.signals)).map((signal) => signal.aborted),
        ).toStrictEqual([true])
      }),
    )
  },
)

describe("the RPC generation", () => {
  it.effect(
    "discards an old response even when the directory returns to its initial value",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const harness = yield* controls,
          held = yield* support.held,
          subject = support.scripted(held.response, harness),
          waiting = yield* Effect.forkChild(
            Effect.flip(usageClient.report(subject)),
          )

        yield* Deferred.await(held.entered)
        yield* Ref.update(harness.generation, (value) => value + NEXT)
        yield* Deferred.succeed(held.release, true)
        expect(yield* Fiber.join(waiting)).toHaveProperty(
          "message",
          expect.stringContaining("discarded"),
        )
      }),
  )
})
