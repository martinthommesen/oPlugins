import { Effect, Fiber, Predicate, Schema } from "effect"
import ClaudeCodeStores from "./claude-code-stores.ts"
import HOST_VERSION from "./host-version.ts"
import type { Plugin } from "@opencode/plugin/effect"
import credentialSwitches from "./credential-switches.ts"
import methodRegistration from "./claude-code-method-registration.ts"
import modelPricing from "./model-pricing.ts"
import pluginLog from "./plugin-log.ts"
import sessionHooks from "./session-hooks.ts"

type Context = Plugin.Context

type Switches = Parameters<typeof credentialSwitches.start>[typeof FIRST]

/** The parts of the host's plugin context this plugin uses. */
interface Host {
  readonly event: { readonly subscribe: Switches["subscribe"] }
  readonly integration: {
    readonly connection: Switches["connection"]
    readonly transform: Parameters<
      typeof methodRegistration.register
    >[typeof FIRST]
  }
  readonly model: {
    readonly reload: Switches["reload"]
    readonly transform: Parameters<typeof modelPricing.register>[typeof FIRST]
  }
  /** The plugin's options, decoded before the plugin is set up. */
  readonly options: Context["options"]
  readonly session: Pick<Context["session"], "hook">
}

const AnyFunction = Schema.declare(Predicate.isFunction),
  /** A connection API offering `active`. */
  ConnectionActive = Schema.Struct({
    connection: Schema.Struct({ active: AnyFunction }),
  }),
  /** A connection API offering `resolve`. */
  ConnectionResolve = Schema.Struct({
    connection: Schema.Struct({ resolve: AnyFunction }),
  }),
  FIRST = 0,
  NONE_MISSING = 0,
  /** Each host capability this plugin needs, and how to tell it is there. */
  REQUIRED_CAPABILITIES = [
    [
      "integration.transform",
      Schema.is(
        Schema.Struct({
          integration: Schema.Struct({ transform: AnyFunction }),
        }),
      ),
    ],
    [
      "integration.connection.active",
      Schema.is(Schema.Struct({ integration: ConnectionActive })),
    ],
    [
      "integration.connection.resolve",
      Schema.is(Schema.Struct({ integration: ConnectionResolve })),
    ],
    [
      "model.transform",
      Schema.is(
        Schema.Struct({ model: Schema.Struct({ transform: AnyFunction }) }),
      ),
    ],
    [
      "model.reload",
      Schema.is(
        Schema.Struct({ model: Schema.Struct({ reload: AnyFunction }) }),
      ),
    ],
    [
      "event.subscribe",
      Schema.is(
        Schema.Struct({ event: Schema.Struct({ subscribe: AnyFunction }) }),
      ),
    ],
    [
      "session.hook",
      Schema.is(
        Schema.Struct({ session: Schema.Struct({ hook: AnyFunction }) }),
      ),
    ],
  ] as const,
  /*
   * Fail clearly on a host whose plugin API lacks what this release targets,
   * naming the version it was built for and what is missing.
   */
  checkCapabilities = (
    host: Readonly<Record<string, never>> | Host,
  ): Effect.Effect<void> => {
    const missing = REQUIRED_CAPABILITIES.flatMap(([name, isPresent]) => {
      if (isPresent(host)) {
        return []
      }

      return [name]
    })

    if (missing.length === NONE_MISSING) {
      return Effect.void
    }

    return Effect.die(
      new Error(
        `oc-auth did not start because it targets OpenCode ${HOST_VERSION}, and this OpenCode lacks plugin APIs it needs: ${missing.join(", ")}. Update OpenCode, or use an oc-auth release built for your OpenCode version.`,
      ),
    )
  },
  /*
   * Discover the accounts on this machine while the session hooks register.
   * Discovery can take seconds on a slow Keychain, and the hooks do nothing
   * until a credential loads. A discovery failure (a locked Keychain, say)
   * is kept, so /connect can show its cause instead of reporting that no
   * credentials exist.
   */
  discoverWhileHooking = Effect.fn("ClaudeAuth.discover")(
    function* discoverWhileHooking(hook: Host["session"]["hook"]) {
      const found = yield* (yield* ClaudeCodeStores).readAccounts.pipe(
        Effect.tapError((failure: { readonly message: string }) =>
          pluginLog.debug("account_discovery_failed", {
            error: failure.message,
          }),
        ),
        Effect.exit,
        Effect.forkScoped,
      )

      yield* sessionHooks.register(hook)

      return yield* Fiber.join(found)
    },
  ),
  /* Set the plugin up on `host`, for as long as the host keeps it loaded. */
  setUp = Effect.fn("ClaudeAuth.setUp")(function* setUp(host: Host) {
    yield* checkCapabilities(host)

    const discovery = yield* discoverWhileHooking(host.session.hook)

    yield* methodRegistration.register(host.integration.transform, discovery)
    yield* credentialSwitches.start({
      connection: host.integration.connection,
      reload: host.model.reload,
      subscribe: host.event.subscribe,
    })
    yield* modelPricing.register(host.model.transform)
  })

/** Setting up the plugin on a host, given the services it runs on. */
export default Object.freeze({
  checkCapabilities,
  setUp,
})
