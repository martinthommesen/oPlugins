import {
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import Advisor from "./advisor.ts"
import ConsultationTimedOut from "./consultation-timed-out-error.ts"
import Host from "./host.ts"
import { Model } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import { Session } from "@opencode/schema/session"
import SessionRecord from "./session-record.test-support.ts"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import support from "./advisor.test-support.ts"

type FakeSession = Parameters<
  typeof Host.fromPlugin<string>
>[typeof FIRST]["session"]

type Advice = Effect.Success<ReturnType<Advisor["Service"]["consult"]>>

type ConsultationError = Effect.Error<ReturnType<Advisor["Service"]["consult"]>>

interface Scenario {
  readonly create?: Effect.Effect<void>
  readonly generate?: Effect.Effect<string, string>
  readonly parent?: Effect.Effect<void>
  readonly remove?: Effect.Effect<void, string>
  readonly subagents?: boolean
  readonly transcript?: Effect.Effect<readonly never[]>
}

/** The tests in a block that provides the advisor around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<Advisor | Host | SessionRecord | Scope.Scope>
}

const CHILD_ID = Session.ID.make("ses_advisor_child"),
  CHILD_INFO = Schema.decodeEffect(Session.Info)({
    cost: 0,
    id: CHILD_ID,
    location: { directory: "/advisor-test" },
    parentID: support.SESSION_ID,
    projectID: "project_test",
    time: { created: 0, updated: 0 },
    tokens: {
      cache: { read: 0, write: 0 },
      input: 0,
      output: 0,
      reasoning: 0,
    },
  }),
  FIRST = 0,
  MODEL = Model.Ref.parse("anthropic/claude-opus-5-5"),
  SLOW_SECONDS = 10,
  TIMEOUT_SECONDS = 1,
  /* The host's session API as `scenario` scripts it, recording in `record`. */
  apiFor = (
    scenario: Scenario,
    child: Session.Info,
    record: SessionRecord["Service"],
  ): FakeSession => ({
    context: () => scenario.transcript ?? Effect.succeed([]),
    create: () => (scenario.create ?? Effect.void).pipe(Effect.as(child)),
    generate: () =>
      Deferred.succeed(record.begun, true).pipe(
        Effect.andThen(scenario.generate ?? Effect.succeed("Advice.")),
        Effect.map((text) => ({ text })),
      ),
    get: () => (scenario.parent ?? Effect.void).pipe(Effect.as(child)),
    remove: () =>
      Ref.update(record.removals, (ids) => [...ids, CHILD_ID]).pipe(
        Effect.andThen(scenario.remove ?? Effect.void),
      ),
    synthetic: () => Effect.die("unexpected notification"),
  }),
  /* The advisor and host on a host scripted by `scenario`, and its record. */
  arrange = (scenario: Scenario): Layer.Layer<Advisor | Host | SessionRecord> =>
    support
      .pluginServices(
        Layer.unwrap(
          Effect.gen(function* scriptedHost() {
            const child = yield* Effect.orDie(CHILD_INFO),
              record = yield* SessionRecord

            return Host.fromPlugin({
              model: {
                list: () =>
                  Effect.succeed({ data: [], location: child.location }),
              },
              session: apiFor(scenario, child, record),
            })
          }),
        ).pipe(Layer.provideMerge(SessionRecord.layer)),
        {
          model: "anthropic/claude-opus-5-5",
          subagents: scenario.subagents ?? true,
          timeout: TIMEOUT_SECONDS,
        },
      )
      .pipe(Layer.orDie),
  /** The block's advisor and host, and what the host's session API was asked. */
  arranged = Effect.gen(function* arranged() {
    const { begun, removals } = yield* SessionRecord

    return { advisor: yield* Advisor, begun, host: yield* Host, removals }
  }),
  /* Starts a consultation, lets the clock run past the deadline, and awaits it. */
  awaitTimeout = (
    advisor: Advisor["Service"],
  ): Effect.Effect<readonly [Duration.Duration, ConsultationError], Advice> =>
    advisor.consult(support.SESSION_ID, Option.none()).pipe(
      Effect.flip,
      Effect.timed,
      Effect.forkChild,
      Effect.tap(() => TestClock.adjust(`${SLOW_SECONDS} seconds`)),
      Effect.flatMap((fiber) => Fiber.join(fiber)),
    ),
  boundsCleanup = Effect.gen(function* boundsCleanup() {
    const { advisor, removals } = yield* arranged,
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
  }),
  boundsParentLookup = Effect.gen(function* boundsParentLookup() {
    const { advisor } = yield* arranged,
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
  }),
  boundsTranscriptLoading = Effect.gen(function* boundsTranscriptLoading() {
    const { advisor } = yield* arranged,
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
  }),
  cleansUpFailure = Effect.gen(function* cleansUpFailure() {
    const { host, removals } = yield* arranged,
      error = yield* host
        .consult(support.SESSION_ID, "Question", MODEL)
        .pipe(Effect.flip)

    yield* Effect.yieldNow

    assert.strictEqual(error.operation, "session.generate")
    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
  }),
  cleansUpInterruption = Effect.gen(function* cleansUpInterruption() {
    const { begun, host, removals } = yield* arranged,
      running = yield* host
        .consult(support.SESSION_ID, "Question", MODEL)
        .pipe(Effect.forkChild)

    yield* Deferred.await(begun)

    assert.isTrue(yield* host.isConsultation(CHILD_ID))

    yield* Fiber.interrupt(running)

    yield* Effect.yieldNow

    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
    assert.isFalse(yield* host.isConsultation(CHILD_ID))
  }),
  cleansUpSuccess = Effect.gen(function* cleansUpSuccess() {
    const { host, removals } = yield* arranged

    assert.strictEqual(
      yield* host.consult(support.SESSION_ID, "Question", MODEL),
      "Advice.",
    )

    yield* Effect.yieldNow

    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
    assert.isFalse(yield* host.isConsultation(CHILD_ID))
  }),
  doesNotDelayAdvice = Effect.gen(function* doesNotDelayAdvice() {
    const { advisor } = yield* arranged,
      [duration, advice] = yield* advisor
        .consult(support.SESSION_ID, Option.none())
        .pipe(Effect.timed)

    assert.strictEqual(advice.text, "Advice.")
    assert.isTrue(Duration.isZero(duration))

    yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)
  }),
  failedGeneration = arrange({ generate: Effect.fail("provider unavailable") }),
  failedRemoval = arrange({ remove: Effect.fail("remove unavailable") }),
  /* A removal that fails the first time `failed` is unset, then succeeds. */
  failingOnce = (failed: Ref.Ref<boolean>): Effect.Effect<void, string> =>
    Effect.gen(function* transientRemoval() {
      if (!(yield* Ref.get(failed))) {
        yield* Ref.set(failed, true)

        return yield* Effect.fail("remove unavailable")
      }

      return yield* Effect.void
    }),
  /** A host whose first session removal fails and whose retry succeeds. */
  flakyRemoval = Layer.unwrap(
    Ref.make(false).pipe(
      Effect.map((failed) => arrange({ remove: failingOnce(failed) })),
    ),
  ),
  interruptsCreation = Effect.gen(function* interruptsCreation() {
    const { advisor, removals } = yield* arranged,
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
    assert.deepStrictEqual(yield* Ref.get(removals), [])
  }),
  keepsFailedCleanupTracked = Effect.gen(function* keepsFailedCleanupTracked() {
    const { host } = yield* arranged

    yield* host.consult(support.SESSION_ID, "Question", MODEL)

    yield* Effect.yieldNow

    assert.isTrue(yield* host.isConsultation(CHILD_ID))
  }),
  retriesDeletion = Effect.gen(function* retriesDeletion() {
    const { host, removals } = yield* arranged

    yield* host.consult(support.SESSION_ID, "Question", MODEL)

    yield* Effect.yieldNow

    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID, CHILD_ID])
    assert.isFalse(yield* host.isConsultation(CHILD_ID))
  }),
  stalledCleanup = arrange({ generate: Effect.never, remove: Effect.never }),
  stalledParent = arrange({ parent: Effect.never, subagents: false })

describe("host consultation lifecycle", () => {
  test.layer(arrange({}))((it: Tests) => {
    it.effect("removes successful consultation sessions", () => cleansUpSuccess)
  })
  test.layer(arrange({ create: Effect.never }))((it: Tests) => {
    it.effect(
      "interrupts a stalled session creation at the deadline",
      () => interruptsCreation,
    )
  })
  test.layer(stalledCleanup)((it: Tests) => {
    it.effect("bounds cleanup when session removal stalls", () => boundsCleanup)
  })
  test.layer(failedRemoval)((it: Tests) => {
    it.effect(
      "keeps failed deletions identifiable as advisor sessions",
      () => keepsFailedCleanupTracked,
    )
  })
  test.layer(arrange({ transcript: Effect.never }))((it: Tests) => {
    it.effect(
      "includes transcript loading in the deadline",
      () => boundsTranscriptLoading,
    )
  })
  test.layer(stalledParent)((it: Tests) => {
    it.effect(
      "includes the parent lookup in the deadline",
      () => boundsParentLookup,
    )
  })
  test.layer(arrange({ remove: Effect.never }))((it: Tests) => {
    it.effect(
      "does not delay successful advice for stalled cleanup",
      () => doesNotDelayAdvice,
    )
  })
  test.layer(flakyRemoval)((it: Tests) => {
    it.effect("retries a transient deletion failure", () => retriesDeletion)
  })
  test.layer(failedGeneration)((it: Tests) => {
    it.effect("cleans up after generation fails", () => cleansUpFailure)
  })
  test.layer(arrange({ generate: Effect.never }))((it: Tests) => {
    it.effect(
      "cleans up after the caller interrupts generation",
      () => cleansUpInterruption,
    )
  })
})
