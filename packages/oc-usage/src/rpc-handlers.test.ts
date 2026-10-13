import { Context, Deferred, Effect, Layer, Option, Ref, Schema } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import type { Scope } from "effect"
import SidebarSetting from "./sidebar-setting.ts"
import type UsageRpc from "./usage-rpc.ts"
import UsageTracker from "./usage-tracker.ts"
import type { Vitest } from "@effect/vitest"
import hostFakes from "./plugin-host.test-support.ts"
import rpcHandlers from "./rpc-handlers.ts"
import usageReport from "./usage-report.ts"

/** An event the fake registration sent. */
type Event = readonly [string, { readonly shown: boolean }]

/** How the fake registration sends an event. */
type Emit = RpcRegistration<typeof UsageRpc>["events"]["emit"]

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<CapturedLogs | Scope.Scope>
}

const FIVE_HOUR_USED = 10,
  MEASURED_AT = 0,
  /** A report with one Claude measurement, with no plan and no reset time. */
  REPORT = usageReport.UsageReport.make({
    subscriptions: [
      {
        state: usageReport.Measured.make({
          measuredAt: MEASURED_AT,
          plan: Option.none(),
          problem: Option.some("Down."),
          windows: [
            {
              label: "5-hour",
              resetsAt: Option.none(),
              usedPercent: Option.some(FIVE_HOUR_USED),
            },
          ],
        }),
        title: "Claude",
      },
    ],
  }),
  /** `REPORT`'s wire form, in which none is `null`. */
  REPORT_JSON =
    '{"subscriptions":[{"state":{"_tag":"Measured","measuredAt":0,"plan":null,"problem":"Down.","windows":[{"label":"5-hour","resetsAt":null,"usedPercent":10}]},"title":"Claude"}]}',
  decodeJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  ),
  /*
   * The RPC's handlers over a tracker that reports `REPORT` and the sidebar
   * setting in memory, whose registration sends each event with `emit`.
   */
  handlersOver = Effect.fnUntraced(function* handlersOver(emit: Emit) {
    const registered = yield* Deferred.make<RpcRegistration<typeof UsageRpc>>(),
      setting = yield* Layer.build(
        SidebarSetting.fromStorage(hostFakes.memoryStorage()),
      ),
      tracked = Context.add(
        setting,
        UsageTracker,
        UsageTracker.of({ report: Effect.succeed(REPORT) }),
      )

    yield* Deferred.succeed(registered, {
      dispose: Effect.void,
      events: { emit },
    })

    return rpcHandlers.handlersOf(tracked, registered)
  }),
  /* The handlers of `handlersOver`, and the events their registration sent. */
  handlersWithEvents = Effect.gen(function* handlersWithEvents() {
    const events = yield* Ref.make<readonly Event[]>([]),
      handlers = yield* handlersOver((name, data) =>
        Ref.update(events, (earlier): readonly Event[] => [
          ...earlier,
          [name, data],
        ]),
      )

    return { handlers, sent: events }
  })

describe("the report method", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("answers with the report's JSON form", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const { handlers } = yield* handlersWithEvents

        expect(yield* handlers.report()).toStrictEqual(
          yield* decodeJson(REPORT_JSON),
        )
      }).pipe(Effect.scoped),
    )
  })
})

describe("the sidebar methods", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("save the setting, and tell every CLI it changed", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const { handlers, sent } = yield* handlersWithEvents,
          initial = yield* handlers.sidebar(),
          saved = yield* handlers.setSidebar({ shown: true }),
          stored = yield* handlers.sidebar()

        expect([initial, saved, stored]).toStrictEqual([
          { shown: false },
          { shown: true },
          { shown: true },
        ])
        expect(yield* Ref.get(sent)).toStrictEqual([
          ["sidebarChanged", { shown: true }],
        ])
      }).pipe(Effect.scoped),
    )
  })
})

describe("a sidebar change that can't reach the other CLIs", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("is saved anyway, with a warning naming why", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const handlers = yield* handlersOver(() => Effect.fail("closed")),
          logs = yield* CapturedLogs,
          saved = yield* handlers.setSidebar({ shown: true })

        expect(saved).toStrictEqual({ shown: true })
        expect(yield* logs.named("sidebar_change_unannounced")).toStrictEqual([
          {
            annotations: { category: "unknown" },
            level: "Warn",
            message: "sidebar_change_unannounced",
          },
        ])
      }).pipe(Effect.scoped),
    )
  })
})
