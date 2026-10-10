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
import { SESSION_ID, memoryStorage } from "./testing.ts"
import { assert, describe, it } from "@effect/vitest"
import { Advisor } from "./advisor.ts"
import { ConsultationTimedOut } from "./errors/consultation-timed-out.ts"
import { Host } from "./host.ts"
import type { HostContext } from "./host.ts"
import { Model } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import { TestClock } from "effect/testing"
import { servicesLayer } from "./services.ts"

const TIMEOUT_SECONDS = 1

const SLOW_SECONDS = 10

const CHILD_ID = Session.ID.make("ses_advisor_child")

const MODEL = Model.Ref.parse("anthropic/claude-opus-5-5")

interface Scenario {
  readonly create?: Effect.Effect<void>
  readonly generate?: Effect.Effect<string, string>
  readonly parent?: Effect.Effect<void>
  readonly remove?: Effect.Effect<void, string>
  readonly subagents?: boolean
  readonly transcript?: Effect.Effect<readonly never[]>
}

const sessionInfo = Schema.decodeUnknownEffect(Session.Info)({
  cost: 0,
  id: CHILD_ID,
  location: { directory: "/advisor-test" },
  parentID: SESSION_ID,
  projectID: "project_test",
  time: { created: 0, updated: 0 },
  tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
})

const fixture = Effect.fn("fixture")(function* fixture(scenario: Scenario) {
  const child = yield* sessionInfo

  const removals = yield* Ref.make<readonly string[]>([])

  const session: HostContext["session"] = {
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
  }

  const hostLayer = Host.fromPlugin({
    model: {
      list: () => Effect.succeed({ data: [], location: child.location }),
    },
    session,
  })

  const built = yield* Layer.build(
    servicesLayer(
      hostLayer,
      {
        model: "anthropic/claude-opus-5-5",
        subagents: scenario.subagents ?? true,
        timeout: TIMEOUT_SECONDS,
      },
      memoryStorage(),
    ),
  )

  return {
    advisor: Context.get(built, Advisor),
    host: Context.get(built, Host),
    removals,
  }
})

const cleansUpSuccess = Effect.gen(function* cleansUpSuccess() {
  const { host, removals } = yield* fixture({})

  assert.strictEqual(
    yield* host.consult(SESSION_ID, "Question", MODEL),
    "Advice.",
  )

  yield* Effect.yieldNow

  assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
  assert.isFalse(yield* host.isConsultation(CHILD_ID))
})

const interruptsCreation = Effect.gen(function* interruptsCreation() {
  const { advisor, removals } = yield* fixture({ create: Effect.never })

  const request = advisor
    .consult(SESSION_ID, Option.none())
    .pipe(Effect.flip, Effect.timed)

  const fiber = yield* Effect.forkChild(request)

  yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)

  const [duration, error] = yield* Fiber.join(fiber)

  assert.instanceOf(error, ConsultationTimedOut)
  assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
  assert.deepStrictEqual(yield* Ref.get(removals), [])
})

const boundsCleanup = Effect.gen(function* boundsCleanup() {
  const { advisor, removals } = yield* fixture({
    generate: Effect.never,
    remove: Effect.never,
  })

  const request = advisor
    .consult(SESSION_ID, Option.none())
    .pipe(Effect.flip, Effect.timed)

  const fiber = yield* Effect.forkChild(request)

  yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)

  const [duration, error] = yield* Fiber.join(fiber)

  assert.instanceOf(error, ConsultationTimedOut)
  assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
  assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
})

const keepsFailedCleanupTracked = Effect.gen(
  function* keepsFailedCleanupTracked() {
    const { host } = yield* fixture({
      remove: Effect.fail("remove unavailable"),
    })

    yield* host.consult(SESSION_ID, "Question", MODEL)

    yield* Effect.yieldNow

    assert.isTrue(yield* host.isConsultation(CHILD_ID))
  },
)

const boundsTranscriptLoading = Effect.gen(function* boundsTranscriptLoading() {
  const { advisor } = yield* fixture({ transcript: Effect.never })

  const fiber = yield* advisor
    .consult(SESSION_ID, Option.none())
    .pipe(Effect.flip, Effect.timed, Effect.forkChild)

  yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)

  const [duration, error] = yield* Fiber.join(fiber)

  assert.instanceOf(error, ConsultationTimedOut)
  assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
})

const boundsParentLookup = Effect.gen(function* boundsParentLookup() {
  const { advisor } = yield* fixture({ parent: Effect.never, subagents: false })

  const fiber = yield* advisor
    .consult(SESSION_ID, Option.none())
    .pipe(Effect.flip, Effect.timed, Effect.forkChild)

  yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)

  const [duration, error] = yield* Fiber.join(fiber)

  assert.instanceOf(error, ConsultationTimedOut)
  assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
})

const doesNotDelayAdvice = Effect.gen(function* doesNotDelayAdvice() {
  const { advisor } = yield* fixture({ remove: Effect.never })

  const [duration, advice] = yield* advisor
    .consult(SESSION_ID, Option.none())
    .pipe(Effect.timed)

  assert.strictEqual(advice.text, "Advice.")
  assert.isTrue(Duration.isZero(duration))

  yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)
})

const retriesDeletion = Effect.gen(function* retriesDeletion() {
  const failed = yield* Ref.make(false)

  const remove = Effect.gen(function* transientRemoval() {
    if (!(yield* Ref.get(failed))) {
      yield* Ref.set(failed, true)

      return yield* Effect.fail("remove unavailable")
    }

    return yield* Effect.void
  })

  const { host, removals } = yield* fixture({ remove })

  yield* host.consult(SESSION_ID, "Question", MODEL)

  yield* Effect.yieldNow

  assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID, CHILD_ID])
  assert.isFalse(yield* host.isConsultation(CHILD_ID))
})

const cleansUpFailure = Effect.gen(function* cleansUpFailure() {
  const { host, removals } = yield* fixture({
    generate: Effect.fail("provider unavailable"),
  })

  const error = yield* host
    .consult(SESSION_ID, "Question", MODEL)
    .pipe(Effect.flip)

  yield* Effect.yieldNow

  assert.strictEqual(error.operation, "session.generate")
  assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
})

const cleansUpInterruption = Effect.gen(function* cleansUpInterruption() {
  const started = yield* Deferred.make<boolean>()

  const generate = Deferred.succeed(started, true).pipe(
    Effect.andThen(Effect.never),
  )

  const { host, removals } = yield* fixture({ generate })

  const fiber = yield* host
    .consult(SESSION_ID, "Question", MODEL)
    .pipe(Effect.forkChild)

  yield* Deferred.await(started)

  assert.isTrue(yield* host.isConsultation(CHILD_ID))

  yield* Fiber.interrupt(fiber)

  yield* Effect.yieldNow

  assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
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
