import { Effect, Fiber, Latch, Struct } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import AnthropicFetchError from "./anthropic-fetch-error.ts"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
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

/** A turn the caller can cancel once recovery reached a step. */
interface Turn {
  /** Cancel the turn, as the user does. */
  readonly cancel: Effect.Effect<void>
  /** Wait until the turn is cancelled. */
  readonly cancelled: Effect.Effect<void>
  readonly signal: AbortSignal
  /** Mark the step the test waits for as reached. */
  readonly reach: Effect.Effect<boolean>
  /** Wait until recovery reached the step. */
  readonly reached: Effect.Effect<void>
}

const ONE = 1,
  UNAUTHORIZED = 401,
  /* A replay `fetch` rejected because its signal aborted. */
  abortedFetch = Effect.fail(
    AnthropicFetchError.make({
      cause: new DOMException("aborted", "AbortError"),
      message: "the replayed request failed",
    }),
  ),
  /* A script whose refresh and replay answer as given. */
  answering = (refresh: Script["refresh"], fetch: Script["fetch"]): Script =>
    Struct.assign(PluginRig.quiet, { fetch, refresh }),
  /* A turn nothing has cancelled yet. */
  cancellable = (): Turn => {
    const controller = new AbortController(),
      ended = Latch.makeUnsafe(false),
      step = Latch.makeUnsafe(false)

    return {
      cancel: Effect.sync(() => {
        controller.abort()
      }).pipe(Effect.andThen(ended.open)),
      cancelled: ended.await,
      reach: step.open,
      reached: step.await,
      signal: controller.signal,
    }
  },
  /*
   * Send a request in `turn`, answer it with a 401, cancel the turn once
   * recovery reached its step, and what the caller gets.
   */
  cancelledIn = Effect.fn("test.cancelledIn")(function* cancelledIn(
    turn: Turn,
  ) {
    yield* fakeHost.setUp

    const recovering = yield* scenario
      .send(scenario.abortable(turn.signal))
      .pipe(
        Effect.flatMap((outbound) =>
          scenario.respond(outbound, scenario.unauthorized()),
        ),
        Effect.forkChild,
      )

    yield* turn.reached
    yield* turn.cancel

    return yield* Fiber.join(recovering)
  }),
  /* The turn cancelled while recovery waits for a refresh. */
  duringRefresh = cancellable(),
  /* The turn cancelled while the replay waits for its response. */
  duringReplay = cancellable(),
  /* The turn cancelled by the replay itself, which then fails. */
  failingReplay = cancellable(),
  /*
   * The refresh, shared with other callers, so not given up, comes back
   * only after the turn is cancelled.
   */
  refreshingHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      () =>
        duringRefresh.reach.pipe(
          Effect.andThen(duringRefresh.cancelled),
          Effect.as(scenario.adopted("second")),
          Effect.uninterruptible,
        ),
      () => Effect.succeed(scenario.unauthorized()),
    ),
  ),
  /* The replay's response does not come before the turn is cancelled. */
  replayingHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      () => Effect.succeed(scenario.adopted("second")),
      () => duringReplay.reach.pipe(Effect.andThen(Effect.never)),
    ),
  ),
  /* Failures recovery reported, and the requests it replayed. */
  reported = Effect.all([
    CapturedLogs.pipe(
      Effect.flatMap((logs) => logs.named("unauthorized_recovery_failed")),
    ),
    PluginRig.pipe(Effect.flatMap((rig) => rig.sent)),
  ]),
  /* The replay cancels the turn, and fails as an aborted `fetch` does. */
  selfCancellingHost = scenario.onHost(
    scenario.ours("first"),
    answering(
      () => Effect.succeed(scenario.adopted("second")),
      () =>
        failingReplay.reach.pipe(
          Effect.andThen(failingReplay.cancel),
          Effect.andThen(abortedFetch),
        ),
    ),
  )

describe("401 recovery whose turn is cancelled", () => {
  test.layer(refreshingHost)((it: Tests) => {
    it.effect("does not replay after a refresh it stopped waiting for", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const answered = yield* cancelledIn(duringRefresh)

        expect([
          answered.status,
          yield* transformsSupport.bodyText(answered),
        ]).toStrictEqual([UNAUTHORIZED, "unauthorized"])
        expect(yield* reported).toStrictEqual([[], []])
      }),
    )
  })

  test.layer(replayingHost)((it: Tests) => {
    it.effect("stops waiting for the replay's response", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const answered = yield* cancelledIn(duringReplay),
          [failures, sent] = yield* reported

        expect(answered.status).toBe(UNAUTHORIZED)
        expect([failures, sent.length]).toStrictEqual([[], ONE])
      }),
    )
  })

  test.layer(selfCancellingHost)((it: Tests) => {
    it.effect("does not report the aborted replay as a failure", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const answered = yield* cancelledIn(failingReplay),
          [failures, sent] = yield* reported

        expect(answered.status).toBe(UNAUTHORIZED)
        expect([failures, sent.length]).toStrictEqual([[], ONE])
      }),
    )
  })
})
