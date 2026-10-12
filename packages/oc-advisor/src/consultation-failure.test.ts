import { Effect, Predicate, Schema } from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import Advisor from "./advisor.ts"
import { Agent } from "@opencode/plugin/effect"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Scope } from "effect"
import TOOL_NAME from "./tool-name.ts"
import type { Vitest } from "@effect/vitest"
import failures from "./host-failure.test-support.ts"
import hooks from "./hooks.ts"
import scripted from "./scripted-host.test-support.ts"
import tool from "./tool.ts"

/** The tests in a block that provides the advisor around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<Advisor | CapturedLogs | Scope.Scope>
}

const { MODEL, arrange } = scripted,
  /*
   * Presents the advisor to the consulting session, whose parent lookup
   * fails, and checks the warning names `category` and the tool is hidden.
   */
  checkFails = Effect.fn("checkFails")(function* checkFails(category: string) {
    const advisor = yield* Advisor,
      event = {
        agent: Agent.ID.make("build"),
        messages: [],
        model: MODEL,
        options: {},
        sessionID: failures.TOOL_CONTEXT.sessionID,
        system: [],
        tools: { [TOOL_NAME]: { description: "Advisor", input: {} } },
      }

    yield* hooks.presentAdvisor(advisor)(event)

    assert.isFalse(Predicate.hasProperty(event.tools, TOOL_NAME))
    assert.deepStrictEqual(
      yield* (yield* CapturedLogs).named("advisor_availability_check_failed"),
      [
        {
          annotations: {
            category,
            operation: "session.get",
            sessionID: failures.TOOL_CONTEXT.sessionID,
          },
          level: "Warn",
          message: "advisor_availability_check_failed",
        },
      ],
    )
    assert.isFalse(yield* failures.leaked)
  }),
  /* Consults through the advisor tool; returns what the agent reads. */
  consult = Effect.gen(function* consult() {
    const advisor = yield* Advisor,
      result = yield* tool
        .advisorTool(advisor)
        .execute({}, failures.TOOL_CONTEXT)
        .pipe(Effect.orDie)

    return yield* Schema.decodeUnknownEffect(Schema.String)(
      result.content,
    ).pipe(Effect.orDie)
  }),
  /* Checks the consultation's warning names `category`, and leaks nothing. */
  consultationFails = Effect.fn("consultationFails")(
    function* consultationFails(category: string) {
      const content = yield* consult

      assert.deepStrictEqual(
        yield* (yield* CapturedLogs).named("advisor_consultation_failed"),
        [
          {
            annotations: {
              category,
              error: "HostError",
              operation: "session.generate",
            },
            level: "Warn",
            message: "advisor_consultation_failed",
          },
        ],
      )
      assert.include(content, "The advisor request failed (session.generate).")
      assert.notInclude(content, failures.SECRET)
      assert.isFalse(yield* failures.leaked)
    },
  )

describe("a failed consultation's record", () => {
  test.layer(arrange({ generate: Effect.fail(failures.NOT_FOUND) }))(
    (it: Tests) => {
      it.effect("names the category of the host's failure", () =>
        consultationFails("not_found"),
      )
    },
  )
  test.layer(arrange({ generate: Effect.fail(failures.THROTTLED) }))(
    (it: Tests) => {
      it.effect("names the category of the provider's failure", () =>
        consultationFails("rate_limited"),
      )
    },
  )
  test.layer(arrange({ generate: Effect.fail(failures.SECRET) }))(
    (it: Tests) => {
      it.effect("falls back to unknown for an unstructured failure", () =>
        consultationFails("unknown"),
      )
    },
  )
})

describe("a failed availability check's record", () => {
  test.layer(
    arrange({ parent: Effect.fail(failures.NOT_FOUND), subagents: false }),
  )((it: Tests) => {
    it.effect("names the category of the host's failure", () =>
      checkFails("not_found"),
    )
  })
  test.layer(
    arrange({ parent: Effect.fail(failures.SECRET), subagents: false }),
  )((it: Tests) => {
    it.effect("falls back to unknown for an unstructured failure", () =>
      checkFails("unknown"),
    )
  })
})
