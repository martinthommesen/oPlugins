import { Effect, Match, Struct } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import AnthropicFetchError from "./anthropic-fetch-error.ts"
import CredentialRefresh from "./credential-refresh.ts"
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

const FIRST_CALL = 1,
  ONE = 1,
  RETRY_AFTER_MS = 12_300,
  SETTLE_YIELDS = 20,
  TOO_MANY_REQUESTS = 429,
  UNAUTHORIZED = 401,
  /* A healthy script whose refresh and replay answer as given. */
  answering = (
    refresh: Script["refresh"],
    fetch: Script["fetch"] = PluginRig.quiet.fetch,
  ): Script => Struct.assign(PluginRig.quiet, { fetch, refresh }),
  /* A refresh that fails unexpectedly. */
  brokenHost = scenario.onHost(
    scenario.ours("first"),
    answering(() => Effect.die(new Error("unexpected"))),
  ),
  /* A replay that fails before any response. */
  failingFetch = Effect.fail(
    AnthropicFetchError.make({
      cause: new TypeError("fetch failed"),
      message: "the replayed request failed",
    }),
  ),
  failingReplayHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      () => Effect.succeed(scenario.adopted("second")),
      () => failingFetch,
    ),
  ),
  /* The adopted credential is rejected too; its body is left unread. */
  retainedReplay = scenario.releasable(),
  /* Send a request, answer it with a 401, and what the caller gets. */
  roundTrip = Effect.gen(function* sendAndAnswer() {
    yield* fakeHost.setUp

    return yield* scenario.respond(
      yield* scenario.send(scenario.messages()),
      scenario.unauthorized(),
    )
  }),
  /* The first replay is rejected, and the second fails outright. */
  secondReplayFailsHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      (call) =>
        Effect.succeed(
          Match.value(call).pipe(
            Match.when(FIRST_CALL, () => scenario.adopted("second")),
            Match.orElse(() => scenario.refreshed("third")),
          ),
        ),
      (call) =>
        Match.value(call).pipe(
          Match.when(FIRST_CALL, () => Effect.succeed(retainedReplay.response)),
          Match.orElse(() => failingFetch),
        ),
    ),
  ),
  /* Refreshing is in a cooldown for a while. */
  transientHost = scenario.onHost(
    scenario.ours("first"),
    answering(() =>
      Effect.succeed(
        CredentialRefresh.Result.Transient({ retryAfterMs: RETRY_AFTER_MS }),
      ),
    ),
  )

describe("401 recovery while refresh is unavailable", () => {
  test.layer(transientHost)((it: Tests) => {
    it.effect(
      "turns a transient refresh into an explicitly retryable 429",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const answered = yield* roundTrip

          expect(answered.status).toBe(TOO_MANY_REQUESTS)
          expect(answered.headers.get("x-should-retry")).toBe("true")
          // Whole seconds, rounded up so a client never retries early.
          expect(answered.headers.get("retry-after")).toBe("13")
          expect(yield* (yield* PluginRig).sent).toStrictEqual([])
        }),
    )
  })

  test.layer(brokenHost)((it: Tests) => {
    it.effect("returns the original 401 when recovery fails unexpectedly", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        /*
         * An error must not escape the hook: the 401 is a well-formed provider
         * error the SDK already knows how to report.
         */
        const answered = yield* roundTrip

        expect([
          answered.status,
          yield* transformsSupport.bodyText(answered),
        ]).toStrictEqual([UNAUTHORIZED, "unauthorized"])
      }),
    )
  })
})

describe("401 recovery whose replay fails", () => {
  test.layer(failingReplayHost)((it: Tests) => {
    it.effect("returns the original 401 when the replay itself throws", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        // The hook must absorb the network error, not reject the whole turn.
        const answered = yield* roundTrip

        expect(yield* (yield* PluginRig).sent).toHaveLength(ONE)
        expect(answered.status).toBe(UNAUTHORIZED)
      }),
    )
  })

  test.layer(secondReplayFailsHost)((it: Tests) => {
    it.effect(
      "releases a replay it opened but did not return when a later replay throws",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const answered = yield* roundTrip

          yield* Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS }))

          // The caller still gets the untouched original, not the dropped replay.
          expect(answered.status).toBe(UNAUTHORIZED)
          // Without the release, undici holds the abandoned connection open.
          expect(retainedReplay.released()).toBe(ONE)
        }),
    )
  })
})
