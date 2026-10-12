import { Deferred, Effect, Fiber, Layer, Ref } from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import type Advisor from "./advisor.ts"
import type Host from "./host.ts"
import type { Scope } from "effect"
import type SessionRecord from "./session-record.test-support.ts"
import type { Vitest } from "@effect/vitest"
import consultationAgent from "./consultation-agent.ts"
import scripted from "./scripted-host.test-support.ts"
import support from "./advisor.test-support.ts"

/** The tests in a block that provides the advisor around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<Advisor | Host | SessionRecord | Scope.Scope>
}

const { CHILD_ID, MODEL, arrange, arranged } = scripted,
  /* What a consultation session must be created with. */
  asConsultationAgent = Effect.gen(function* asConsultationAgent() {
    const { creations, host } = yield* arranged

    yield* host.consult(support.SESSION_ID, "Question", MODEL)

    // The session's rules apply after the agent's, so they must not allow any tool again.
    assert.deepStrictEqual(yield* Ref.get(creations), [
      {
        agent: consultationAgent.ID,
        model: MODEL,
        parentID: support.SESSION_ID,
        permissions: [{ action: "*", effect: "deny", resource: "*" }],
        title: "Advisor",
      },
    ])
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
    const { begun, deletions, host, removals } = yield* arranged,
      running = yield* host
        .consult(support.SESSION_ID, "Question", MODEL)
        .pipe(Effect.forkChild)

    yield* Deferred.await(begun)
    yield* Fiber.interrupt(running)

    yield* Effect.yieldNow

    assert.deepStrictEqual(yield* Ref.get(removals), [CHILD_ID])
    assert.deepStrictEqual(yield* Ref.get(deletions), [CHILD_ID])
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
   * Gets advice, then checks the removals its cleanup asked for and the
   * deletions that succeeded.
   */
  removesAfterAdvice = Effect.fn("removesAfterAdvice")(
    function* removesAfterAdvice(
      removed: readonly string[],
      deleted: readonly string[],
    ) {
      const { deletions, host, removals } = yield* arranged

      assert.strictEqual(
        yield* host.consult(support.SESSION_ID, "Question", MODEL),
        "Advice.",
      )

      yield* Effect.yieldNow

      assert.deepStrictEqual(yield* Ref.get(removals), removed)
      assert.deepStrictEqual(yield* Ref.get(deletions), deleted)
    },
  )

describe("host consultation sessions", () => {
  test.layer(arrange({}))((it: Tests) => {
    it.effect(
      "run as the consultation agent, with no tool allowed",
      () => asConsultationAgent,
    )
  })
})

describe("host consultation cleanup", () => {
  test.layer(arrange({}))((it: Tests) => {
    it.effect("removes successful consultation sessions", () =>
      removesAfterAdvice([CHILD_ID], [CHILD_ID]),
    )
  })
  test.layer(failedRemoval)((it: Tests) => {
    it.effect("tries a failing deletion once more, then gives up", () =>
      removesAfterAdvice([CHILD_ID, CHILD_ID], []),
    )
  })
  test.layer(flakyRemoval)((it: Tests) => {
    it.effect("retries a transient deletion failure", () =>
      removesAfterAdvice([CHILD_ID, CHILD_ID], [CHILD_ID]),
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
