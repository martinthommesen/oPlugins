import { assert, describe, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import { Effect } from "effect"
import Host from "./host.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import failures from "./host-failure.test-support.ts"
import scripted from "./scripted-host.test-support.ts"
import support from "./advisor.test-support.ts"

/** The tests in a block that provides the host and the logs. */
interface Tests {
  readonly effect: Vitest.Test<CapturedLogs | Host | Scope.Scope>
}

const { CHILD_ID, MODEL, arrange } = scripted,
  SLOW_SECONDS = 10,
  /*
   * Gets advice, lets its cleanup fail, and checks the advice still
   * arrived, and the warning carries `why` and leaks nothing.
   */
  cleanupFails = Effect.fn("cleanupFails")(function* cleanupFails(
    why: Readonly<Record<string, string>>,
  ) {
    const advice = yield* (yield* Host).consult(
      support.SESSION_ID,
      "Question",
      MODEL,
    )

    yield* TestClock.adjust(`${SLOW_SECONDS} seconds`)

    assert.strictEqual(advice, "Advice.")
    assert.deepStrictEqual(
      yield* (yield* CapturedLogs).named("advisor_session_cleanup_failed"),
      [
        {
          annotations: why,
          level: "Warn",
          message: "advisor_session_cleanup_failed",
        },
      ],
    )
    assert.isFalse(yield* failures.leaked)
  })

describe("a failed consultation session cleanup's record", () => {
  test.layer(arrange({ remove: Effect.fail(failures.NOT_FOUND) }))(
    (it: Tests) => {
      it.effect("says retries ran out, with the last failure's category", () =>
        cleanupFails({
          category: "not_found",
          reason: "retries_exhausted",
          sessionID: CHILD_ID,
        }),
      )
    },
  )
  test.layer(arrange({ remove: Effect.fail(failures.SECRET) }))((it: Tests) => {
    it.effect("falls back to unknown for an unstructured failure", () =>
      cleanupFails({
        category: "unknown",
        reason: "retries_exhausted",
        sessionID: CHILD_ID,
      }),
    )
  })
  test.layer(arrange({ remove: Effect.never }))((it: Tests) => {
    it.effect("says the deadline passed", () =>
      cleanupFails({ reason: "timeout", sessionID: CHILD_ID }),
    )
  })
})
