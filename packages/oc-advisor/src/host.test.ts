import {
  Context,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Scope,
} from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import type Advisor from "./advisor.ts"
import ConsultationTimedOut from "./consultation-timed-out-error.ts"
import Host from "./host.ts"
import SessionRecord from "./session-record.test-support.ts"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import scripted from "./scripted-host.test-support.ts"
import support from "./advisor.test-support.ts"

type Scenario = Parameters<typeof scripted.arrange>[typeof FIRST]

/** The tests in a block that provides the advisor around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<Advisor | Host | SessionRecord | Scope.Scope>
}

const { CHILD_ID, MODEL, TIMEOUT_SECONDS, arrange, arranged } = scripted,
  FIRST = 0,
  REMOVAL_SECONDS = 2,
  SLOW_SECONDS = 10,
  /*
   * Consults on a host scripted by `scenario`, closes the plugin's scope while
   * the deletion runs, and checks the outcome once the scope has closed.
   * `deleted` says whether the deletion should have succeeded.
   */
  closeMidCleanup = Effect.fn("closeMidCleanup")(function* closeMidCleanup(
    scenario: Scenario,
    deleted: readonly string[],
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
    assert.deepStrictEqual(
      yield* Ref.get(Context.get(services, SessionRecord).deletions),
      deleted,
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

describe("host consultation cleanup as the plugin closes", () => {
  test.effect("finishes a pending deletion first", () =>
    closeMidCleanup({ remove: Effect.sleep(`${REMOVAL_SECONDS} seconds`) }, [
      CHILD_ID,
    ]),
  )
  test.effect("gives up on a stalled deletion at its deadline", () =>
    closeMidCleanup({ remove: Effect.never }, []),
  )
})
