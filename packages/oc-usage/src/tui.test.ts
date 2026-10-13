import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import cliHost from "./cli-host.test-support.ts"
import tuiPlugin from "./tui.ts"
import usageReport from "./usage-report.ts"

type Server = Parameters<typeof cliHost.make>[typeof FIRST]

const FIRST = 0,
  FIVE_HOUR_USED = 34,
  LISTENER = 1,
  /** A report of Claude's measurement, without reset times, which depend on the clock. */
  MEASURED = usageReport.UsageReport.make({
    subscriptions: [
      {
        state: usageReport.Measured.make({
          measuredAt: 0,
          plan: Option.some("Max"),
          problem: Option.none(),
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
  NO_LISTENER = 0,
  /** Long enough for the RPC's answers to reach the plugin. */
  SETTLE = "30 millis",
  /** A report with neither subscription connected. */
  UNCONNECTED = usageReport.UsageReport.make({
    subscriptions: [
      {
        state: usageReport.Disconnected.make({ hint: "Connect Anthropic." }),
        title: "Claude",
      },
      {
        state: usageReport.Disconnected.make({ hint: "Connect OpenAI." }),
        title: "Codex",
      },
    ],
  }),
  /** The sidebar section for `UNCONNECTED`. */
  UNCONNECTED_LINES = ["Usage", "Connect Claude or ChatGPT with /connect."],
  /* A fake CLI host over `server`, with the CLI plugin set up on it. */
  setUp = (server: Server): ReturnType<typeof cliHost.make> =>
    cliHost.make(server, (host) => tuiPlugin.setup(host)),
  settle = Effect.sleep(SETTLE)

describe("the CLI plugin's commands", () => {
  it(
    "adds /usage and /show-usage to the palette and the prompt",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(tuiPlugin.id).toBe("martinthommesen.oc-usage.cli")
      expect(setUp(cliHost.answering(UNCONNECTED, false)).layers).toMatchObject(
        [
          {
            commands: [
              {
                id: "oc-usage.report",
                palette: true,
                slash: { name: "usage" },
              },
              {
                id: "oc-usage.sidebar",
                palette: true,
                slash: { arguments: true, name: "show-usage" },
              },
            ],
            mode: "global",
          },
        ],
      )
    },
  )
})

describe("/usage", () => {
  it.live("shows the report in a dialog", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(cliHost.answering(UNCONNECTED, false))

      yield* fake.run("oc-usage.report")

      expect(fake.alerts).toStrictEqual([
        {
          message: [
            "Claude",
            "  Not connected. Connect Anthropic.",
            "",
            "Codex",
            "  Not connected. Connect OpenAI.",
          ].join("\n"),
          title: "Subscription usage",
        },
      ])
      expect(fake.toasts).toStrictEqual([])
    }),
  )

  it.live("says why when the server plugin doesn't answer", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp({ report: Effect.fail("unanswered"), shown: false })

      yield* fake.run("oc-usage.report")

      expect(fake.toasts).toStrictEqual([
        {
          message:
            "oc-usage couldn't read usage. The RPC failed; the server may be unavailable or the operation may have failed. Retry, then check the OpenCode server logs and that oc-usage is in plugins in opencode.jsonc.",
          variant: "error",
        },
      ])
      expect(fake.alerts).toStrictEqual([])
    }),
  )
})

describe("/show-usage on and off", () => {
  it.live("save the setting, and show or hide the section", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(cliHost.answering(UNCONNECTED, false)),
        frame = yield* fake.mount

      yield* settle

      expect(yield* frame()).toStrictEqual([])

      yield* fake.run("oc-usage.sidebar", "on")
      yield* settle

      expect(yield* frame()).toStrictEqual(UNCONNECTED_LINES)

      yield* fake.run("oc-usage.sidebar", "off")

      expect(yield* frame()).toStrictEqual([])
      expect(fake.saved).toStrictEqual([true, false])
    }).pipe(Effect.scoped),
  )

  it.live("say what they did", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(cliHost.answering(UNCONNECTED, false))

      yield* fake.run("oc-usage.sidebar", "ON")
      yield* fake.run("oc-usage.sidebar", "off")

      expect(fake.toasts).toStrictEqual([
        {
          message: "Usage is in the sidebar until /show-usage off.",
          variant: "success",
        },
        { message: "Usage is no longer in the sidebar.", variant: "success" },
      ])
    }),
  )
})

describe("/show-usage with anything else", () => {
  it.live("toggles the section when it's alone", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(cliHost.answering(UNCONNECTED, false))

      yield* settle
      yield* fake.run("oc-usage.sidebar")
      yield* fake.run("oc-usage.sidebar", "")

      expect(fake.saved).toStrictEqual([true, false])
    }),
  )

  it.live("only says what it takes otherwise", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(cliHost.answering(UNCONNECTED, false))

      yield* fake.run("oc-usage.sidebar", "maybe")

      expect(fake.saved).toStrictEqual([])
      expect(fake.toasts).toStrictEqual([
        {
          message: '/show-usage takes on or off, not "maybe".',
          variant: "warning",
        },
      ])
    }),
  )
})

describe("the saved sidebar setting", () => {
  it.live("is shown when the CLI starts", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const frame = yield* setUp(cliHost.answering(UNCONNECTED, true)).mount

      yield* settle

      expect(yield* frame()).toStrictEqual(UNCONNECTED_LINES)
    }).pipe(Effect.scoped),
  )

  it.live("follows a change another CLI saved", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(cliHost.answering(UNCONNECTED, false)),
        frame = yield* fake.mount

      yield* settle
      fake.announce(true)
      yield* settle

      expect(yield* frame()).toStrictEqual(UNCONNECTED_LINES)

      fake.announce(false)
      yield* settle

      expect(yield* frame()).toStrictEqual([])
    }).pipe(Effect.scoped),
  )
})

describe("the plugin's unload", () => {
  it.live("stops being followed once the plugin unloads", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(cliHost.answering(UNCONNECTED, false)),
        frame = yield* fake.mount

      yield* settle

      expect(fake.listening()).toBe(LISTENER)

      fake.cleanup()
      fake.announce(true)

      expect(fake.listening()).toBe(NO_LISTENER)
      expect(yield* frame()).toStrictEqual([])
    }).pipe(Effect.scoped),
  )
})

describe("the sidebar section", () => {
  it.live("shows each measured subscription's windows", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const frame = yield* setUp(cliHost.answering(MEASURED, true)).mount

      yield* settle

      expect(yield* frame()).toStrictEqual([
        "Usage",
        "Claude · Max",
        "5-hour   34%",
      ])
    }).pipe(Effect.scoped),
  )

  it.live("stops asking for the report once it's hidden", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp({ report: Effect.never, shown: true })

      yield* fake.mount
      yield* settle
      fake.announce(false)
      yield* settle

      expect(fake.reportSignals.map((signal) => signal.aborted)).toStrictEqual([
        true,
      ])
    }).pipe(Effect.scoped),
  )
})
