import {
  Context,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
} from "effect"
import { assert, describe, it } from "@effect/vitest"
import Advisor from "./advisor.ts"
import ConsultationTimedOut from "./consultation-timed-out-error.ts"
import Host from "./host.ts"
import { Model } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { TestClock } from "effect/testing"
import services from "./services.ts"
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
  /* The host's session API as `scenario` scripts it, recording removals. */
  apiFor = (
    scenario: Scenario,
    child: Session.Info,
    removals: Ref.Ref<readonly string[]>,
  ): FakeSession => ({
    context: () => scenario.transcript ?? Effect.succeed([]),
    create: () => (scenario.create ?? Effect.void).pipe(Effect.as(child)),
    generate: () =>
      (scenario.generate ?? Effect.succeed("Advice.")).pipe(
        Effect.map((text) => ({ text })),
      ),
    get: () => (scenario.parent ?? Effect.void).pipe(Effect.as(child)),
    remove: () =>
      Ref.update(removals, (ids) => [...ids, CHILD_ID]).pipe(
        Effect.andThen(scenario.remove ?? Effect.void),
      ),
    synthetic: () => Effect.die("unexpected notification"),
  }),
  /* The advisor and host on a host scripted by `scenario`, and its removals. */
  arrange = Effect.fn("fixture")(function* fixture(scenario: Scenario) {
    const child = yield* CHILD_INFO,
      removals = yield* Ref.make<readonly string[]>([]),
      session = apiFor(scenario, child, removals),
      wired = yield* Layer.build(
        services.layer(
          Host.fromPlugin({
            model: {
              list: () =>
                Effect.succeed({ data: [], location: child.location }),
            },
            session,
          }),
          {
            model: "anthropic/claude-opus-5-5",
            subagents: scenario.subagents ?? true,
            timeout: TIMEOUT_SECONDS,
          },
          support.memoryStorage(),
        ),
      )

    return {
      advisor: Context.get(wired, Advisor),
      host: Context.get(wired, Host),
      removals,
    }
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
    const { advisor, removals } = yield* arrange({
        generate: Effect.never,
        remove: Effect.never,
      }),
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
  }),
  boundsParentLookup = Effect.gen(function* boundsParentLookup() {
    const { advisor } = yield* arrange({
        parent: Effect.never,
        subagents: false,
      }),
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
  }),
  boundsTranscriptLoading = Effect.gen(function* boundsTranscriptLoading() {
    const { advisor } = yield* arrange({ transcript: Effect.never }),
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
  }),
  cleansUpFailure = Effect.gen(function* cleansUpFailure() {
    const { host, removals } = yield* arrange({
        generate: Effect.fail("provider unavailable"),
      }),
      error = yield* host
        .consult(support.SESSION_ID, "Question", MODEL)
        .pipe(Effect.flip)

    yield* Effect.yieldNow

    assert.strictEqual(error.operation, "session.generate")
    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
  }),
  cleansUpInterruption = Effect.gen(function* cleansUpInterruption() {
    const begun = yield* Deferred.make<boolean>(),
      generate = Deferred.succeed(begun, true).pipe(
        Effect.andThen(Effect.never),
      ),
      { host, removals } = yield* arrange({ generate }),
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
    const { host, removals } = yield* arrange({})

    assert.strictEqual(
      yield* host.consult(support.SESSION_ID, "Question", MODEL),
      "Advice.",
    )

    yield* Effect.yieldNow

    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
    assert.isFalse(yield* host.isConsultation(CHILD_ID))
  }),
  doesNotDelayAdvice = Effect.gen(function* doesNotDelayAdvice() {
    const { advisor } = yield* arrange({ remove: Effect.never }),
      [duration, advice] = yield* advisor
        .consult(support.SESSION_ID, Option.none())
        .pipe(Effect.timed)

    assert.strictEqual(advice.text, "Advice.")
    assert.isTrue(Duration.isZero(duration))

    yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)
  }),
  interruptsCreation = Effect.gen(function* interruptsCreation() {
    const { advisor, removals } = yield* arrange({ create: Effect.never }),
      [duration, error] = yield* awaitTimeout(advisor)

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
    assert.deepStrictEqual(yield* Ref.get(removals), [])
  }),
  keepsFailedCleanupTracked = Effect.gen(function* keepsFailedCleanupTracked() {
    const { host } = yield* arrange({
      remove: Effect.fail("remove unavailable"),
    })

    yield* host.consult(support.SESSION_ID, "Question", MODEL)

    yield* Effect.yieldNow

    assert.isTrue(yield* host.isConsultation(CHILD_ID))
  }),
  retriesDeletion = Effect.gen(function* retriesDeletion() {
    const failed = yield* Ref.make(false),
      remove = Effect.gen(function* transientRemoval() {
        if (!(yield* Ref.get(failed))) {
          yield* Ref.set(failed, true)

          return yield* Effect.fail("remove unavailable")
        }

        return yield* Effect.void
      }),
      { host, removals } = yield* arrange({ remove })

    yield* host.consult(support.SESSION_ID, "Question", MODEL)

    yield* Effect.yieldNow

    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID, CHILD_ID])
    assert.isFalse(yield* host.isConsultation(CHILD_ID))
  })

describe("host consultation lifecycle", () => {
  it.effect("removes successful consultation sessions", () => cleansUpSuccess)
  it.effect(
    "interrupts a stalled session creation at the deadline",
    () => interruptsCreation,
  )
  it.effect("bounds cleanup when session removal stalls", () => boundsCleanup)
  it.effect(
    "keeps failed deletions identifiable as advisor sessions",
    () => keepsFailedCleanupTracked,
  )
  it.effect(
    "includes transcript loading in the deadline",
    () => boundsTranscriptLoading,
  )
  it.effect(
    "includes the parent lookup in the deadline",
    () => boundsParentLookup,
  )
  it.effect(
    "does not delay successful advice for stalled cleanup",
    () => doesNotDelayAdvice,
  )
  it.effect("retries a transient deletion failure", () => retriesDeletion)
  it.effect("cleans up after generation fails", () => cleansUpFailure)
  it.effect(
    "cleans up after the caller interrupts generation",
    () => cleansUpInterruption,
  )
})
