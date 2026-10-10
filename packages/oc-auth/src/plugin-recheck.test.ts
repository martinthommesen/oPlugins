import { Effect, Match } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CredentialRefresh from "./credential-refresh.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import PluginRig from "./plugin-rig.test-support.ts"
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

type Script = typeof PluginRig.quiet

const CACHE_WINDOW_MS = 30_000,
  /** Long past, so the cached token has expired by the first request. */
  LONG_AGO = 1000,
  ONE = 1,
  ROTATING_CALL = 2,
  SETTLE_YIELDS = 20,
  TWO = 2,
  /* A rig whose store adoption answers per `adopt`. */
  adopting = (adopt: Script["adopt"]): Script =>
    Object.freeze({
      accounts: PluginRig.quiet.accounts,
      adopt,
      fetch: PluginRig.quiet.fetch,
      refresh: PluginRig.quiet.refresh,
    }),
  /* A store that Claude Code rotated to `second`. */
  adoptsSecond = (): ReturnType<Script["adopt"]> =>
    Effect.succeed(scenario.adopted("second")),
  /* The authorization a fresh request goes out with. */
  authorization = scenario
    .send(scenario.messages())
    .pipe(Effect.map((request) => request.headers.get("authorization"))),
  expiredHost = scenario.onHost(
    FakeConnection.oauth("first", LONG_AGO),
    adopting(adoptsSecond),
  ),
  /* The authorization of a request sent once the cache window has passed. */
  nextWindow = TestClock.adjust(CACHE_WINDOW_MS).pipe(
    Effect.andThen(authorization),
  ),
  /* How many times the store was re-checked, once background work has run. */
  rechecks = Effect.yieldNow.pipe(
    Effect.repeat({ times: SETTLE_YIELDS }),
    Effect.andThen(PluginRig),
    Effect.flatMap((rig) => rig.adopts),
  ),
  /* The second re-check finds a rotation; the others find nothing new. */
  rotatesOnSecond = adopting((call) =>
    Match.value(call).pipe(
      Match.when(ROTATING_CALL, adoptsSecond),
      Match.orElse(() => Effect.succeed(CredentialRefresh.Result.Unchanged())),
    ),
  ),
  rotatingHost = scenario.onHost(scenario.ours("first"), rotatesOnSecond)

describe("the request path's source re-check", () => {
  test.layer(rotatingHost)((it: Tests) => {
    it.effect(
      "re-checks the source once per cache window on the request path",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* TestClock.setTime(CACHE_WINDOW_MS)
          yield* fakeHost.setUp

          const first = yield* authorization,
            firstChecks = yield* rechecks,
            second = yield* nextWindow,
            secondChecks = yield* rechecks,
            third = yield* authorization

          expect([first, firstChecks]).toStrictEqual(["Bearer first", ONE])
          /*
           * The re-check runs beside the request rather than in front of it, so
           * a rotation is picked up by the request after. The token it replaces
           * is still valid, and a 401 recovers through adoption anyway.
           */
          expect([second, secondChecks]).toStrictEqual(["Bearer first", TWO])
          expect([third, yield* rechecks]).toStrictEqual(["Bearer second", TWO])
        }),
    )
  })

  test.layer(expiredHost)((it: Tests) => {
    it.effect("waits for the re-check when the cached token has expired", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* TestClock.setTime(CACHE_WINDOW_MS)
        yield* fakeHost.setUp

        // Past the cached token's expiry: sending it is a certain 401.
        expect(yield* authorization).toBe("Bearer second")
        expect(yield* rechecks).toBe(ONE)
      }),
    )
  })
})
