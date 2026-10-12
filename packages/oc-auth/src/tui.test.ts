import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import cliHost from "./cli-host.test-support.ts"
import { createSignal } from "solid-js"
import tuiPlugin from "./tui.ts"

type FakeCliHost = ReturnType<typeof cliHost.make>

type Session = Parameters<FakeCliHost["update"]>[typeof SECOND]

type TokenUsage = Session["tokens"]

const CACHE = "oc-auth.cache",
  /** What the sidebar shows for `cold`. */
  COLD_LINES = [
    "Cache",
    "25.0% hit · 75.0% miss",
    "250 read · 250 write · 500 uncached",
    "Last request 99.0% hit",
  ],
  /** A session with no prompt tokens yet. */
  FRESH: Session = {
    messages: [],
    tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
  },
  SECOND = 1,
  /** What the sidebar shows for `warm`. */
  WARM_LINES = [
    "Cache",
    "90.0% hit · 10.0% miss",
    "900 read · 0 write · 100 uncached",
  ],
  /* A usage record with these prompt counts and some output. */
  byCounts = (counts: {
    readonly input: number
    readonly read: number
    readonly write: number
  }): TokenUsage => ({
    cache: { read: counts.read, write: counts.write },
    input: counts.input,
    output: 50,
    reasoning: 10,
  }),
  /** A session that mostly missed the cache; its last request hit 99%. */
  cold: Session = {
    messages: [
      {
        tokens: byCounts({ input: 10, read: 990, write: 0 }),
        type: "assistant",
      },
      { type: "user" },
    ],
    tokens: byCounts({ input: 500, read: 250, write: 250 }),
  },
  /* A fake CLI host with the CLI plugin set up on it. */
  setUp = (): FakeCliHost => {
    const fake = cliHost.make()

    tuiPlugin.setup(fake.host)

    return fake
  },
  /** A session that mostly read from the cache, with no request reported. */
  warm: Session = {
    messages: [],
    tokens: byCounts({ input: 100, read: 900, write: 0 }),
  }

describe("the /cache command", () => {
  it(
    "is in the command palette and is a slash command",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const fake = setUp()

      expect(fake.layers).toMatchObject([
        {
          commands: [{ id: CACHE, palette: true, slash: { name: "cache" } }],
          mode: "global",
        },
      ])
    },
  )
})

describe("/cache outside a session", () => {
  it.effect("shows a warning", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp()

      yield* fake.run(CACHE)

      expect(fake.toasts).toStrictEqual([
        {
          message: "Open a session to see its prompt cache stats",
          variant: "warning",
        },
      ])
      expect(fake.alerts).toStrictEqual([])
    }),
  )
})

describe("/cache in a session", () => {
  it.effect("reports the session the current route shows", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp()

      fake.update("warm", warm)
      fake.update("cold", cold)
      fake.show(Option.some("warm"))
      yield* fake.run(CACHE)
      fake.show(Option.some("cold"))
      yield* fake.run(CACHE)

      expect(fake.alerts).toStrictEqual([
        {
          message: [
            "Session: 90.0% hit · 10.0% miss",
            "  900 read · 0 write · 100 uncached",
            "Last request: no prompt tokens yet",
          ].join("\n"),
          title: "Prompt cache",
        },
        {
          message: [
            "Session: 25.0% hit · 75.0% miss",
            "  250 read · 250 write · 500 uncached",
            "Last request: 99.0% hit · 1.0% miss",
            "  990 read · 0 write · 10 uncached",
          ].join("\n"),
          title: "Prompt cache",
        },
      ])
      expect(fake.toasts).toStrictEqual([])
    }),
  )
})

describe("the sidebar's Cache section", () => {
  it("is appended to sidebar.content", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(setUp().claims.map((claim) => claim.append)).toStrictEqual([
      "sidebar.content",
    ])
  })
})

describe("the sidebar's Cache section for one session", () => {
  it.effect("appears once the session has used a prompt", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(),
        frame = yield* fake.mount(() => "warm")

      expect(yield* frame()).toStrictEqual([])

      fake.update("warm", FRESH)

      expect(yield* frame()).toStrictEqual([])

      fake.update("warm", warm)

      expect(yield* frame()).toStrictEqual(WARM_LINES)
    }),
  )

  it.effect("shows the last request's hit rate when there is one", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(),
        frame = yield* fake.mount(() => "cold")

      fake.update("cold", cold)

      expect(yield* frame()).toStrictEqual(COLD_LINES)
    }),
  )
})

describe("the sidebar's Cache section across sessions", () => {
  it.effect("follows the session the sidebar shows", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fake = setUp(),
        [shown, show] = createSignal("warm"),
        frame = yield* fake.mount(shown)

      fake.update("warm", warm)
      fake.update("fresh", FRESH)
      fake.update("cold", cold)

      expect(yield* frame()).toStrictEqual(WARM_LINES)

      show("fresh")

      expect(yield* frame()).toStrictEqual([])

      show("cold")

      expect(yield* frame()).toStrictEqual(COLD_LINES)
    }),
  )
})
