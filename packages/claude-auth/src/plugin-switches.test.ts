import { Effect, Exit, Scope } from "effect"
import { describe, expect, it } from "@effect/vitest"
import CapturedStderr from "./captured-stderr.test-support.ts"
import FakeCatalog from "./fake-catalog.test-support.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeEvents from "./fake-events.test-support.ts"
import { TestClock } from "effect/testing"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"

type Active = Parameters<typeof FakeConnection.layer>[typeof FIRST]

const FIRST = 0,
  NATIVE = 1,
  ONE = 1,
  RESUBSCRIBE_DELAY_MS = 1000,
  SETTLE_YIELDS = 50,
  TWO = 2,
  ZERO = 0,
  ZERO_COST = Object.freeze({ cost: "zero" }),
  /* Let the plugin's background work run until it waits. */
  allSettled = Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS })),
  /* An API key, as the active connection. */
  apiKeyActive = FakeConnection.apiKey("api-key"),
  /* The authorization a fresh request goes out with. */
  authorization = scenario
    .send(scenario.messages())
    .pipe(Effect.map((request) => request.headers.get("authorization"))),
  /* Switch the host's Anthropic connection to `active`, and let it settle. */
  changeTo = (
    active: Active,
    credentialID: string,
  ): Effect.Effect<void, never, FakeConnection | FakeEvents> =>
    Effect.gen(function* switchConnection() {
      yield* (yield* FakeConnection).setActive(active)
      yield* (yield* FakeEvents).switchTo(credentialID)
      yield* allSettled
    }),
  /* Drop the host's event stream, and wait out the re-subscribe delay. */
  dropAndResubscribe = Effect.gen(function* dropStream() {
    yield* (yield* FakeEvents).drop
    yield* allSettled
    yield* TestClock.adjust(RESUBSCRIBE_DELAY_MS)
    yield* allSettled
  }),
  /* Switch to an API key whose resolution fails. */
  failingChangeTo = FakeConnection.pipe(
    Effect.flatMap((connection) => connection.failNextResolve),
    Effect.andThen(changeTo(apiKeyActive, "key")),
  ),
  hostBefore = scenario.onHost(scenario.ours("before")),
  hostWithAccess = scenario.onHost(scenario.ours("access")),
  /*
   * Set the plugin up in a scope of its own and close it, as the host does
   * when it unloads the plugin: how many event subscriptions had finished
   * while it was loaded, and after.
   */
  loadThenUnload = Effect.gen(function* loadAndUnload() {
    const events = yield* FakeEvents,
      pluginScope = yield* Scope.make(),
      whileLoaded = yield* fakeHost.setUp.pipe(
        Scope.provide(pluginScope),
        Effect.andThen(events.closed),
      )

    yield* Scope.close(pluginScope, Exit.void)

    return { afterUnload: yield* events.closed, whileLoaded }
  }),
  /*
   * Switch to `after` while the switch's resolution is held, and the
   * authorization a request sent meanwhile goes out with.
   */
  racingSwitch = Effect.gen(function* raceSwitch() {
    const heldOpen = yield* (yield* FakeConnection).holdNextResolve,
      racing = yield* changeTo(scenario.ours("after"), "after").pipe(
        Effect.andThen(authorization),
      )

    yield* heldOpen
    yield* allSettled

    return racing
  })

describe("pricing across credential switches", () => {
  it.effect(
    "zeroes only active Anthropic model costs and restores pricing after a switch",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUpWith(ZERO_COST)

        const before = yield* (yield* FakeCatalog).costs,
          catalog = yield* FakeCatalog

        yield* changeTo(apiKeyActive, "key")

        expect(before).toStrictEqual({ anthropic: ZERO, other: NATIVE })
        expect(yield* catalog.reloads).toBe(ONE)
        expect(yield* (yield* FakeConnection).resolves).toBe(TWO)
        expect(yield* catalog.costs).toStrictEqual({
          anthropic: NATIVE,
          other: NATIVE,
        })
      }).pipe(Effect.provide(hostWithAccess)),
  )
})

describe("a switch that fails", () => {
  it.effect(
    "fails a switch closed and continues processing later switches",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUpWith(ZERO_COST)
        yield* failingChangeTo

        const catalog = yield* FakeCatalog,
          failed = yield* authorization,
          warning = yield* (yield* CapturedStderr).text

        yield* changeTo(scenario.ours("replacement"), "replacement")

        expect(failed).toBeNull()
        expect(warning).toMatch(/resolve failed/u)
        expect(yield* catalog.reloads).toBe(TWO)
        expect(yield* catalog.costs).toStrictEqual({
          anthropic: ZERO,
          other: NATIVE,
        })
        expect(yield* authorization).toBe("Bearer replacement")
      }).pipe(Effect.provide(hostWithAccess)),
  )
})

describe("a request racing a switch", () => {
  it.effect(
    "keeps the current credential for a request that races a switch",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const racing = yield* racingSwitch

        expect(racing).toBe("Bearer before")
        expect(yield* (yield* FakeCatalog).reloads).toBe(ONE)
        expect(yield* authorization).toBe("Bearer after")
      }).pipe(Effect.provide(hostBefore)),
  )
})

describe("the host event stream", () => {
  it.effect("resubscribes after the host event stream drops", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* fakeHost.setUp

      const events = yield* FakeEvents,
        first = yield* events.subscriptions

      yield* dropAndResubscribe
      yield* changeTo(apiKeyActive, "key")

      expect(first).toBe(ONE)
      expect(yield* events.subscriptions).toBe(TWO)
      expect(yield* (yield* FakeCatalog).reloads).toBe(ONE)
    }).pipe(Effect.provide(hostWithAccess)),
  )
})

describe("unloading the plugin", () => {
  it.effect("ends its event subscription when the plugin unloads", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      expect(yield* loadThenUnload).toStrictEqual({
        afterUnload: ONE,
        whileLoaded: ZERO,
      })
    }).pipe(Effect.provide(hostWithAccess)),
  )
})
