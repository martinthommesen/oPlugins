import { Effect, Fiber } from "effect"
import type { Layer, Scope } from "effect"
import { expect, it as test } from "@effect/vitest"
import FakeCatalog from "./fake-catalog.test-support.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeEvents from "./fake-events.test-support.ts"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof scenario.onHost>> | Scope.Scope
  >
}

const NONE = 0,
  ONE = 1,
  RESUBSCRIBE_DELAY_MS = 1000,
  SETTLE_YIELDS = 50,
  /* Let the plugin's background work run until it waits. */
  allSettled = Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS })),
  /* An API key, as the active connection. */
  apiKeyActive = FakeConnection.apiKey("api-key"),
  /* The authorization a fresh request goes out with. */
  authorization = scenario
    .send(scenario.messages())
    .pipe(Effect.map((request) => request.headers.get("authorization"))),
  /* Drop the host's event stream, and let the plugin notice. */
  dropStream = FakeEvents.pipe(
    Effect.flatMap((events) => events.drop),
    Effect.andThen(allSettled),
  ),
  hostBefore = scenario.onHost(scenario.ours("before")),
  /* Wait out the re-subscribe delay, and let the plugin catch up. */
  resubscribe = TestClock.adjust(RESUBSCRIBE_DELAY_MS).pipe(
    Effect.andThen(allSettled),
  ),
  /* Switch the host to an API key, announcing it on the event stream. */
  switchToKey = Effect.gen(function* switchToKey() {
    yield* (yield* FakeConnection).setActive(apiKeyActive)
    yield* (yield* FakeEvents).switchTo("key")
    yield* allSettled
  })

test.layer(hostBefore)(
  "a switch while the event stream is down",
  (it: Tests) => {
    it.effect("is caught up with once the plugin re-subscribes", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp
        yield* dropStream
        // No event announces this switch: nothing is subscribed.
        yield* (yield* FakeConnection).setActive(apiKeyActive)

        const missed = yield* authorization,
          reloadsBefore = yield* (yield* FakeCatalog).reloads

        yield* resubscribe

        expect(missed).toBe("Bearer before")
        expect(yield* authorization).toBeNull()
        // Pricing follows the credential in use, so the models reload.
        expect([
          reloadsBefore,
          yield* (yield* FakeCatalog).reloads,
        ]).toStrictEqual([NONE, ONE])
      }),
    )
  },
)

test.layer(hostBefore)(
  "a re-subscription that finds no switch",
  (it: Tests) => {
    it.effect("keeps the credential in use and the models", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp
        yield* dropStream
        yield* resubscribe

        expect(yield* authorization).toBe("Bearer before")
        expect(yield* (yield* FakeCatalog).reloads).toBe(NONE)
      }),
    )
  },
)

test.layer(hostBefore)(
  "a switch while a re-subscription looks up the selection",
  (it: Tests) => {
    it.effect("leaves the newer selection in use", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp
        yield* dropStream

        // The re-subscription's lookup sees `before`, and is held there.
        const release = yield* (yield* FakeConnection).holdNextResolve

        yield* resubscribe
        yield* switchToKey
        yield* release
        yield* allSettled

        expect(yield* authorization).toBeNull()
      }),
    )
  },
)

test.layer(hostBefore)("a switch while the plugin starts up", (it: Tests) => {
  it.effect("leaves the newer selection in use", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      // The startup lookup sees `before`, and is held there.
      const release = yield* (yield* FakeConnection).holdNextResolve,
        starting = yield* Effect.forkChild(fakeHost.setUp)

      yield* allSettled
      yield* switchToKey
      yield* release
      yield* Fiber.join(starting)

      expect(yield* authorization).toBeNull()
    }),
  )
})
