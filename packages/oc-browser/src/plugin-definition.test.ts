import { ConfigProvider, Effect, Layer, Path } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import plugin from "./index.ts"
import support from "./debug-log.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

const EPOCH = "1970-01-01T00:00:00.000Z"

describe("the plugin definition", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("exports one Effect plugin definition", () =>
      Effect.sync(() => {
        expect.hasAssertions()
        expect(plugin.id).toBe("martinthommesen.obrowse")
        expect(Object.keys(plugin).toSorted()).toStrictEqual(["effect", "id"])
      }),
    )
  })
})

describe("the plugin set-up", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("builds its services and records the host's project", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const home = yield* support.sandbox,
          log = (yield* Path.Path).join(home, "start.log"),
          variables = ConfigProvider.fromEnvRecord({
            HOME: home,
            OBROWSE_DEBUG: log,
            XDG_DATA_HOME: home,
          })

        yield* plugin
          .effect({ location: { directory: home } })
          .pipe(
            Effect.scoped,
            Effect.provideService(ConfigProvider.ConfigProvider, variables),
          )

        expect(yield* support.readRecords(log)).toStrictEqual([
          { directory: home, event: "plugin_started", ts: EPOCH },
        ])
      }),
    )
  })
})
