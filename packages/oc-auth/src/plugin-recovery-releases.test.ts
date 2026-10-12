import { Effect, Fiber, Latch, Match, Struct } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
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

/** A response whose body is produced only when it is read. */
interface Held {
  /** How many times its body was released. */
  readonly released: () => number
  readonly response: Response
}

const FIRST_CALL = 1,
  NONE = 0,
  OK = 200,
  ONE = 1,
  SETTLE_YIELDS = 20,
  UNAUTHORIZED = 401,
  /* Send a request, answer it with `response`, and what the caller gets. */
  answer = Effect.fn("test.answer")(function* answer(response: Response) {
    yield* fakeHost.setUp

    return yield* scenario.respond(
      yield* scenario.send(scenario.messages()),
      response,
    )
  }),
  /* A script whose refresh and replay answer as given. */
  answering = (refresh: Script["refresh"], fetch: Script["fetch"]): Script =>
    Struct.assign(PluginRig.quiet, { fetch, refresh }),
  /* The adopted credential is rejected too, and the second refresh hangs. */
  hangReplay = scenario.releasable(),
  /* The second refresh, which never ends, has started. */
  hangStarted = Latch.makeUnsafe(),
  hangingHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      (call) =>
        Match.value(call).pipe(
          Match.when(FIRST_CALL, () =>
            Effect.succeed(scenario.adopted("second")),
          ),
          Match.orElse(() =>
            hangStarted.open.pipe(Effect.andThen(Effect.never)),
          ),
        ),
      () => Effect.succeed(hangReplay.response),
    ),
  ),
  /* A response with `status` whose body, `text`, streams only when read. */
  held = (status: number, text: string): Held => {
    let released = NONE

    return {
      released: () => released,
      response: new Response(
        new ReadableStream(
          {
            cancel: (): void => {
              released += ONE
            },
            pull: (
              controller: Readonly<ReadableStreamDefaultController<Uint8Array>>,
            ): void => {
              controller.enqueue(new TextEncoder().encode(text))
              controller.close()
            },
          },
          { highWaterMark: NONE },
        ),
        { status },
      ),
    }
  },
  /* Let detached work, such as releasing a body, run. */
  settle = Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS })),
  /* The replay with the adopted credential works. */
  succeeding = held(OK, "replayed"),
  succeedingHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      () => Effect.succeed(scenario.adopted("second")),
      () => Effect.succeed(succeeding.response),
    ),
  ),
  /* The adopted credential is rejected, and refreshing keeps its token. */
  unchanged = held(UNAUTHORIZED, "still unauthorized"),
  unchangedHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      (call) =>
        Effect.succeed(
          Match.value(call).pipe(
            Match.when(FIRST_CALL, () => scenario.adopted("second")),
            Match.orElse(() => scenario.refreshed("second")),
          ),
        ),
      () => Effect.succeed(unchanged.response),
    ),
  )

describe("401 recovery that is interrupted", () => {
  test.layer(hangingHost)((it: Tests) => {
    it.effect(
      "releases the original 401 and the replay while the second refresh waits",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const original = scenario.releasable(),
            recovering = yield* Effect.forkChild(answer(original.response))

          yield* hangStarted.await
          yield* Fiber.interrupt(recovering)
          yield* settle

          expect([original.released(), hangReplay.released()]).toStrictEqual([
            ONE,
            ONE,
          ])
        }),
    )
  })
})

describe("401 recovery that returns a replay", () => {
  test.layer(succeedingHost)((it: Tests) => {
    it.effect("returns a working replay still streaming", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const original = scenario.releasable(),
          returned = yield* answer(original.response)

        yield* settle

        expect(returned).toBe(succeeding.response)
        expect([original.released(), succeeding.released()]).toStrictEqual([
          ONE,
          NONE,
        ])
        expect(yield* transformsSupport.bodyText(returned)).toBe("replayed")
      }),
    )
  })

  test.layer(unchangedHost)((it: Tests) => {
    it.effect("returns a rejected replay it keeps unread", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const original = scenario.releasable(),
          returned = yield* answer(original.response)

        yield* settle

        // The refresh kept the token, so the replay's 401 is the answer.
        expect(returned).toBe(unchanged.response)
        expect([original.released(), unchanged.released()]).toStrictEqual([
          ONE,
          NONE,
        ])
        expect(yield* transformsSupport.bodyText(returned)).toBe(
          "still unauthorized",
        )
      }),
    )
  })
})
