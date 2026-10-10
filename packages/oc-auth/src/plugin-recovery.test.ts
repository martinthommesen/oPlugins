import { Effect, Exit, Match, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import FakeConnection from "./fake-connection.test-support.ts"
import type { Layer } from "effect"
import PluginRig from "./plugin-rig.test-support.ts"
import type { Vitest } from "@effect/vitest"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"
import transformsSupport from "./request-transforms.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof scenario.onHost>> | Scope.Scope
  >
}

type Script = typeof PluginRig.quiet

/** A 401 whose body records whether it was released. */
interface Releasable {
  readonly released: () => number
  readonly response: Response
}

const FIRST_CALL = 1,
  OK = 200,
  ONE = 1,
  SETTLE_YIELDS = 20,
  UNAUTHORIZED = 401,
  ZERO = 0,
  /* A healthy script whose refresh and replay answer as given. */
  answering = (
    refresh: Script["refresh"],
    fetch: Script["fetch"] = PluginRig.quiet.fetch,
  ): Script =>
    Object.freeze({
      accounts: PluginRig.quiet.accounts,
      adopt: PluginRig.quiet.adopt,
      fetch,
      refresh,
    }),
  /* A replayed request's body and authorization header. */
  bodyAndAuth = (
    request: Request,
  ): Effect.Effect<readonly [string, string | null]> =>
    transformsSupport
      .bodyText(request.clone())
      .pipe(
        Effect.map(
          (body) => [body, request.headers.get("authorization")] as const,
        ),
      ),
  quietHost = scenario.onHost(FakeConnection.oauth("access")),
  /* A 401 that counts how many times its body is released. */
  releasable = (): Releasable => {
    let released = ZERO

    return {
      released: () => released,
      response: new Response(
        new ReadableStream({
          cancel: (): void => {
            released += ONE
          },
        }),
        { status: UNAUTHORIZED },
      ),
    }
  },
  /* Each replayed request's body and authorization header. */
  replayed = PluginRig.pipe(
    Effect.flatMap((rig) => rig.sent),
    Effect.flatMap((sent) =>
      Effect.forEach(sent, (request) => bodyAndAuth(request), {
        concurrency: ONE,
      }),
    ),
  ),
  /* A store rotated to `second`, whose replay works. */
  rotatedHost = scenario.onHost(
    FakeConnection.oauth("first"),
    answering(
      () => Effect.succeed(scenario.adopted("second")),
      () => Effect.succeed(new Response("replayed", { status: OK })),
    ),
  ),
  /* A refresh that hands back the same access token. */
  sameTokenHost = scenario.onHost(
    FakeConnection.oauth("same"),
    answering(() => Effect.succeed(scenario.refreshed("same"))),
  ),
  /* Let detached work, such as releasing a body, run. */
  settle = Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS })),
  /*
   * A refresh adopts a rotated store before it spends a token, so the first
   * call adopts and the second, after that 401s too, refreshes.
   */
  twoStepHost = scenario.onHost(
    FakeConnection.oauth("first"),
    answering(
      (call) =>
        Effect.succeed(
          Match.value(call).pipe(
            Match.when(FIRST_CALL, () => scenario.adopted("second")),
            Match.orElse(() => scenario.refreshed("third")),
          ),
        ),
      (call) =>
        Effect.succeed(
          Match.value(call).pipe(
            Match.when(
              FIRST_CALL,
              () =>
                new Response("still unauthorized", { status: UNAUTHORIZED }),
            ),
            Match.orElse(() => new Response("ok", { status: OK })),
          ),
        ),
    ),
  ),
  /* The plain 401 the API answered with. */
  unauthorized = (): Response =>
    new Response("unauthorized", { status: UNAUTHORIZED })

test.layer(twoStepHost)("401 recovery by adoption and refresh", (it: Tests) => {
  it.effect(
    "replays two independently buffered bodies after adoption and refresh",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const outbound = yield* scenario.send(
            scenario.messages("complete-body"),
          ),
          sent = yield* transformsSupport.bodyText(outbound.clone()),
          withRecovery = yield* scenario.respond(outbound, unauthorized())

        expect(sent).toBe("complete-body")
        expect(withRecovery.status).toBe(OK)
        expect(yield* replayed).toStrictEqual([
          ["complete-body", "Bearer second"],
          ["complete-body", "Bearer third"],
        ])
        expect(yield* (yield* FakeConnection).resolves).toBe(ONE)
      }),
  )
})

test.layer(rotatedHost)("401 recovery by adoption alone", (it: Tests) => {
  it.effect("returns the replay after adoption without refreshing again", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* fakeHost.setUp

      const held = releasable(),
        reply = yield* scenario.respond(
          yield* scenario.send(scenario.messages()),
          held.response,
        )

      yield* settle

      // A replay that works with the adopted credential ends recovery.
      expect([
        reply.status,
        yield* transformsSupport.bodyText(reply),
      ]).toStrictEqual([OK, "replayed"])
      expect(
        (yield* replayed).map(([, authorization]) => authorization),
      ).toStrictEqual(["Bearer second"])
      expect(yield* (yield* PluginRig).refreshes).toBe(ONE)
      expect(held.released()).toBe(ONE)
    }),
  )
})

describe("401 recovery that cannot replay", () => {
  test.layer(sameTokenHost)((it: Tests) => {
    it.effect(
      "returns the original 401 when a refresh keeps the same access token",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* fakeHost.setUp

          const answered = yield* scenario.respond(
            yield* scenario.send(scenario.messages()),
            unauthorized(),
          )

          // Replaying the identical bearer token would just earn a second 401.
          expect(yield* (yield* PluginRig).sent).toStrictEqual([])
          expect([
            answered.status,
            yield* transformsSupport.bodyText(answered),
          ]).toStrictEqual([UNAUTHORIZED, "unauthorized"])
        }),
    )
  })

  test.layer(quietHost)((it: Tests) => {
    it.effect("does not replay a turn the caller already aborted", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const caller = yield* Scope.make(),
          callerSignal = yield* Effect.abortSignal.pipe(Scope.provide(caller)),
          outbound = yield* scenario.send(scenario.abortable(callerSignal))

        yield* Scope.close(caller, Exit.void)

        expect((yield* scenario.respond(outbound, unauthorized())).status).toBe(
          UNAUTHORIZED,
        )
        expect(yield* (yield* PluginRig).refreshes).toBe(ZERO)
      }),
    )
  })
})
