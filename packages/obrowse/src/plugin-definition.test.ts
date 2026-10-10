import { ConfigProvider, Effect, Path } from "effect"
import { describe, expect, it } from "@effect/vitest"
import plugin from "./index.ts"
import support from "./debug-log.test-support.ts"

const EPOCH = "1970-01-01T00:00:00.000Z"

describe("the plugin definition", () => {
  it.effect("exports one Effect plugin definition", () =>
    Effect.sync(() => {
      expect.hasAssertions()
      expect(plugin.id).toBe("martinthommesen.obrowse")
      expect(Object.keys(plugin).toSorted()).toStrictEqual(["effect", "id"])
    }),
  )
})

describe("the plugin set-up", () => {
  it.effect("builds its services and records the host's project", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const home = yield* support.sandbox,
        log = (yield* Path.Path).join(home, "start.log"),
        variables = ConfigProvider.layer(
          ConfigProvider.fromEnvRecord({
            HOME: home,
            OBROWSE_DEBUG: log,
            XDG_DATA_HOME: home,
          }),
        )

      yield* plugin
        .effect({ location: { directory: home } })
        .pipe(Effect.scoped, Effect.provide(variables))

      expect(yield* support.readRecords(log)).toStrictEqual([
        { directory: home, event: "plugin_started", ts: EPOCH },
      ])
    }).pipe(Effect.provide(support.layer)),
  )
})
