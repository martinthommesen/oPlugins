import { Effect, Exit, Fiber, Layer, Option } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeHooks from "./fake-hooks.test-support.ts"
import HOST_VERSION from "./host-version.ts"
import PluginRig from "./plugin-rig.test-support.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import claudeAuth from "./claude-auth-plugin.ts"
import fakeHost from "./fake-host.test-support.ts"
import plugin from "./index.ts"
import scenario from "./plugin-scenario.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof scenario.onHost>> | Scope.Scope
  >
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

// Connections that are another method's, or no connection at all.
const FOREIGN_CONNECTIONS = [
    ["an API key", FakeConnection.apiKey("api-key")],
    ["the environment's key", FakeConnection.apiKey("env")],
    ["another method's OAuth", FakeConnection.foreign("access")],
    ["no connection", Option.none()],
  ] as const,
  NONE = 0,
  SETTLE_YIELDS = 20,
  /* A host whose account discovery never finishes. */
  discovering = scenario.onHost(
    scenario.ours("access"),
    Object.freeze({
      accounts: Effect.never,
      adopt: PluginRig.quiet.adopt,
      fetch: PluginRig.quiet.fetch,
      refresh: PluginRig.quiet.refresh,
    }),
  ),
  /* The hooks registered so far. */
  registeredHooks = FakeHooks.pipe(Effect.flatMap((hooks) => hooks.names))

describe("the plugin definition", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("exports one Effect plugin definition", () =>
      Effect.sync(() => {
        expect.hasAssertions()
        expect(plugin.id).toBe("martinthommesen.oc-auth")
        expect(Object.keys(plugin).toSorted()).toStrictEqual(["effect", "id"])
      }),
    )
  })

  test.layer(Layer.empty)((it: PureTests) => {
    it.effect(
      "fails clearly when the pinned host capabilities are absent",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const exit = yield* Effect.exit(claudeAuth.checkCapabilities({}))

          expect(Exit.isFailure(exit)).toBe(true)
          expect(String(exit)).toMatch(
            new RegExp(`${HOST_VERSION}.*integration\\.transform`, "u"),
          )
        }),
    )
  })
})

test.layer(discovering)("the plugin during account discovery", (it: Tests) => {
  it.effect(
    "registers the session hooks while accounts are still being discovered",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const setUp = yield* Effect.forkChild(fakeHost.setUp)

        yield* Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS }))

        /*
         * A slow Keychain should not hold back the hooks, which need no
         * account list and do nothing until a credential loads; no
         * credential loads before then.
         */
        expect(yield* registeredHooks).toContain("http.response")
        expect(yield* (yield* FakeConnection).resolves).toBe(NONE)
        yield* Fiber.interrupt(setUp)
      }),
  )
})

describe("connections that are not this plugin's", () => {
  // One block per connection, so each test sets up a plugin of its own.
  for (const [name, active] of FOREIGN_CONNECTIONS) {
    test.layer(scenario.onHost(active))((it: Tests) => {
      it.effect(`leaves ${name} untouched`, () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* fakeHost.setUp

          const event = scenario.contextEvent(),
            original = scenario.messages(),
            system = [...event.system]

          yield* (yield* FakeHooks).fire("context", event)

          expect(event.system).toStrictEqual(system)
          expect(yield* scenario.send(original)).toBe(original)
        }),
      )
    })
  }
})
