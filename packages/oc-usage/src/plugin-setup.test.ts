import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import hostFakes from "./plugin-host.test-support.ts"
import plugin from "./index.ts"

type PluginHost = Parameters<typeof plugin.effect>[typeof FIRST]

/** An RPC setup registered: its ID and its method names. */
type Registered = readonly [string, readonly string[]]

const FIRST = 0,
  /* A host with no connections, which hands each RPC setup registers to `record`. */
  recordingHost = (
    options: PluginHost["options"],
    record: (registered: Registered) => void,
  ): PluginHost => ({
    integration: hostFakes.unconnected.integration,
    options,
    rpc: {
      register: (definition, handlers) =>
        Effect.sync(() => {
          record([definition.id, Object.keys(handlers).toSorted()])
        }).pipe(
          Effect.as({
            dispose: Effect.void,
            events: { emit: () => Effect.void },
          }),
        ),
    },
    storage: hostFakes.memoryStorage(),
  })

describe("the plugin definition", () => {
  it("exports one Effect plugin definition", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(plugin.id).toBe("martinthommesen.oc-usage")
    expect(Object.keys(plugin).toSorted()).toStrictEqual(["effect", "id"])
  })
})

describe("the plugin setup", () => {
  it.effect("registers the oc-usage RPC with its three methods", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const registered: Registered[] = []

      yield* plugin
        .effect(
          recordingHost({}, (rpc) => {
            registered.push(rpc)
          }),
        )
        .pipe(Effect.scoped)

      expect(registered).toStrictEqual([
        ["oc-usage", ["report", "setSidebar", "sidebar"]],
      ])
    }),
  )

  it.effect(
    "fails on an unknown option, naming it, and registers nothing",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const registered: Registered[] = [],
          thrown = yield* plugin
            .effect(
              recordingHost({ interval: "1 minute" }, (rpc) => {
                registered.push(rpc)
              }),
            )
            .pipe(
              Effect.scoped,
              Effect.catchDefect((defect) => Effect.succeed(defect)),
            )

        expect(thrown).toBeInstanceOf(PluginOptionsError)
        expect(thrown).toHaveProperty(
          "message",
          expect.stringContaining(
            "interval: Unknown option (oc-usage has no options).",
          ),
        )
        expect(registered).toStrictEqual([])
      }),
  )
})
