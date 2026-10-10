import { Effect, Layer } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import InvalidOptions from "./invalid-options-error.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import capturedLog from "./captured-log.test-support.ts"
import plugin from "./index.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof capturedLog.layer> | Scope.Scope
  >
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

const PROJECT = "prj_test"

describe("the plugin definition", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("exports one Effect plugin definition", () =>
      Effect.sync(() => {
        expect.hasAssertions()
        expect(plugin.id).toBe("martinthommesen.oc-browser")
        expect(Object.keys(plugin).toSorted()).toStrictEqual(["effect", "id"])
      }),
    )
  })
})

describe("the plugin set-up", () => {
  test.layer(capturedLog.layer)((it: Tests) => {
    it.effect("records the host's project in the host's log", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* plugin
          .effect({ location: { project: { id: PROJECT } }, options: {} })
          .pipe(Effect.scoped)

        expect(yield* capturedLog.records).toStrictEqual([
          {
            annotations: { project: PROJECT },
            level: "INFO",
            message: "plugin_started",
          },
        ])
      }),
    )
  })
})

describe("the plugin options", () => {
  test.layer(capturedLog.layer)((it: Tests) => {
    it.effect("fails set-up on an unknown option, naming it", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const failure = yield* plugin
          .effect({
            location: { project: { id: PROJECT } },
            options: { debug: 1 },
          })
          .pipe(
            Effect.scoped,
            Effect.catchDefect((defect) => Effect.succeed(defect)),
          )

        expect(failure).toBeInstanceOf(InvalidOptions)
        expect(failure).toHaveProperty(
          "message",
          expect.stringContaining("debug: Unknown option."),
        )
        expect(yield* capturedLog.records).toStrictEqual([])
      }),
    )
  })
})
