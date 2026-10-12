import { assert, describe, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import { Effect } from "effect"
import type Host from "./host.ts"
import type PreferenceStore from "./preference-store.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import command from "./command.ts"
import failures from "./host-failure.test-support.ts"
import scripted from "./scripted-host.test-support.ts"

/** The tests in a block that provides the advisor around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<
    CapturedLogs | Host | PreferenceStore | Scope.Scope
  >
}

const { arrange } = scripted,
  /*
   * Sets the advisor model while the host can't list models, and checks the
   * user is told, and the warning names `category` and leaks nothing.
   */
  listingFails = Effect.fn("listingFails")(function* listingFails(
    category: string,
  ) {
    const reply = yield* command.runCommand(
      command.parseCommand("anthropic/claude-opus-5-5"),
    )

    assert.strictEqual(
      reply,
      "Couldn't list the available models because model.list failed. Run the command again.",
    )
    assert.deepStrictEqual(
      yield* (yield* CapturedLogs).named("advisor_model_list_failed"),
      [
        {
          annotations: { category, operation: "model.list" },
          level: "Warn",
          message: "advisor_model_list_failed",
        },
      ],
    )
    assert.isFalse(yield* failures.leaked)
  })

describe("a failed /advisor model listing's record", () => {
  test.layer(arrange({ list: Effect.fail(failures.UNAUTHORIZED) }))(
    (it: Tests) => {
      it.effect("names the category of the host's failure", () =>
        listingFails("unauthorized"),
      )
    },
  )
  test.layer(arrange({ list: Effect.fail(failures.SECRET) }))((it: Tests) => {
    it.effect("falls back to unknown for an unstructured failure", () =>
      listingFails("unknown"),
    )
  })
})
