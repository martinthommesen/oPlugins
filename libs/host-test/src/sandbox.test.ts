import { Effect, Path } from "effect"
import { expect, it as test } from "@effect/vitest"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import sandbox from "./sandbox.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Path.Path | Scope.Scope>
}

test.layer(Path.layer)("the sandbox layout", (it: Tests) => {
  it.effect("keeps the host's files under the sandbox root", () =>
    Effect.gen(function* run() {
      const layout = yield* sandbox.layout("/tmp/oc-test-root")

      expect.hasAssertions()
      expect(layout.hostLog).toBe(
        "/tmp/oc-test-root/data/opencode/log/opencode.log",
      )
      expect(layout.plugins).toBe("/tmp/oc-test-root/config/opencode/plugins")
      expect(layout.opencodeConfig).toBe("/tmp/oc-test-root/config/opencode")
      expect(layout.marker).toBe("/tmp/oc-test-root/started.txt")
    }),
  )

  it.effect("points every XDG directory of the host into it", () =>
    Effect.gen(function* run() {
      const layout = yield* sandbox.layout("/tmp/oc-test-root")

      expect.hasAssertions()
      expect(sandbox.environment(layout)).toStrictEqual({
        XDG_CACHE_HOME: "/tmp/oc-test-root/cache",
        XDG_CONFIG_HOME: "/tmp/oc-test-root/config",
        XDG_DATA_HOME: "/tmp/oc-test-root/data",
        XDG_STATE_HOME: "/tmp/oc-test-root/state",
      })
    }),
  )
})
