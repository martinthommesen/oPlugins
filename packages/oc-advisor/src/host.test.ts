import {
  Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
} from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import Advisor from "./advisor.ts"
import ConsultationTimedOut from "./consultation-timed-out-error.ts"
import Host from "./host.ts"
import { Model } from "@opencode/plugin/effect"
import { Session } from "@opencode/schema/session"
import SessionRecord from "./session-record.test-support.ts"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import support from "./advisor.test-support.ts"

type FakeSession = Parameters<
  typeof Host.fromPlugin<string>
>[typeof FIRST]["session"]

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
    tokens: { cache: { read: 0, write: 0 }, input: 0, output: 0, reasoning: 0 },
  }),
  FIRST = 0,
  MODEL = Model.Ref.parse("anthropic/claude-opus-5-5"),
  REMOVAL_SECONDS = 2,
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
  /*
   * Consults on a host scripted by `scenario`, closes the plugin's scope while
   * the deletion runs, and checks the outcome once the scope has closed.
   * `kept` says whether the session should still be marked as a consultation.
   */
  closeMidCleanup = Effect.fn("closeMidCleanup")(function* closeMidCleanup(
    scenario: Scenario,
    kept: boolean,
  ) {
    const lifetime = yield* Scope.make(),
      services = yield* Layer.buildWithScope(arrange(scenario), lifetime),
      teardown = yield* Context.get(services, Host)
        .consult(support.SESSION_ID, "Question", MODEL)
        .pipe(
          Effect.andThen(Scope.close(lifetime, Exit.void)),
          Effect.forkChild,
        )

    yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)
    yield* Fiber.join(teardown)

    assert.deepStrictEqual(
      yield* Ref.get(Context.get(services, SessionRecord).removals),
      [CHILD_ID],
    )
    assert.strictEqual(
      yield* Context.get(services, Host).isConsultation(CHILD_ID),
      kept,
    )
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
  /* A removal that fails once, then succeeds, recording the failure in `failed`. */
  failingOnce = (failed: Ref.Ref<boolean>): Effect.Effect<void, string> =>
    Effect.fail("remove unavailable").pipe(
      Effect.when(Ref.modify(failed, (done) => [!done, true])),
      Effect.asVoid,
    ),
  /** A host whose first session removal fails and whose retry succeeds. */
  flakyRemoval = Layer.unwrap(
    Ref.make(false).pipe(
      Effect.map((failed) => arrange({ remove: failingOnce(failed) })),
    ),
  ),
  /*
   * Gets advice, then checks the removals its cleanup asked for. `kept` says
   * whether the session should still be marked as a consultation.
   */
  removesAfterAdvice = Effect.fn("removesAfterAdvice")(
    function* removesAfterAdvice(removed: readonly string[], kept: boolean) {
      const { host, removals } = yield* arranged

      assert.strictEqual(
        yield* host.consult(support.SESSION_ID, "Question", MODEL),
        "Advice.",
      )

      yield* Effect.yieldNow

      assert.deepStrictEqual(yield* Ref.get(removals), removed)
      assert.strictEqual(yield* host.isConsultation(CHILD_ID), kept)
    },
  ),
  stalledCleanup = arrange({ generate: Effect.never, remove: Effect.never }),
  stalledParent = arrange({ parent: Effect.never, subagents: false }),
  /* Times a consultation out at the deadline, having removed `expected`. */
  timesOutRemoving = Effect.fn("timesOutRemoving")(function* timesOutRemoving(
    expected: readonly string[],
  ) {
    const { advisor, removals } = yield* arranged,
      [duration, error] = yield* advisor
        .consult(support.SESSION_ID, Option.none())
        .pipe(
          Effect.flip,
          Effect.timed,
          Effect.forkChild,
          Effect.tap(() => TestClock.adjust(`${SLOW_SECONDS} seconds`)),
          Effect.flatMap((fiber) => Fiber.join(fiber)),
        )

    assert.instanceOf(error, ConsultationTimedOut)
    assert.strictEqual(Duration.toSeconds(duration), TIMEOUT_SECONDS)
    assert.deepStrictEqual(yield* Ref.get(removals), expected)
  })

describe("host consultation deadline", () => {
  test.layer(arrange({ create: Effect.never }))((it: Tests) => {
    it.effect("interrupts a stalled session creation at the deadline", () =>
      timesOutRemoving([]),
    )
  })
  test.layer(stalledCleanup)((it: Tests) => {
    it.effect("bounds cleanup when session removal stalls", () =>
      timesOutRemoving([CHILD_ID]),
    )
  })
  test.layer(arrange({ transcript: Effect.never }))((it: Tests) => {
    it.effect("includes transcript loading in the deadline", () =>
      timesOutRemoving([]),
    )
  })
  test.layer(stalledParent)((it: Tests) => {
    it.effect("includes the parent lookup in the deadline", () =>
      timesOutRemoving([]),
    )
  })
  test.layer(arrange({ remove: Effect.never }))((it: Tests) => {
    it.effect(
      "does not delay successful advice for stalled cleanup",
      () => doesNotDelayAdvice,
    )
  })
})

describe("host consultation cleanup", () => {
  test.layer(arrange({}))((it: Tests) => {
    it.effect("removes successful consultation sessions", () =>
      removesAfterAdvice([CHILD_ID], false),
    )
  })
  test.layer(failedRemoval)((it: Tests) => {
    it.effect("keeps sessions it fails to delete marked as consultations", () =>
      removesAfterAdvice([CHILD_ID, CHILD_ID], true),
    )
  })
  test.layer(flakyRemoval)((it: Tests) => {
    it.effect("retries a transient deletion failure", () =>
      removesAfterAdvice([CHILD_ID, CHILD_ID], false),
    )
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

describe("host consultation cleanup as the plugin closes", () => {
  test.effect("finishes a pending deletion first", () =>
    closeMidCleanup(
      { remove: Effect.sleep(`${REMOVAL_SECONDS} seconds`) },
      false,
    ),
  )
  test.effect("gives up on a stalled deletion at its deadline", () =>
    closeMidCleanup({ remove: Effect.never }, true),
  )
})
