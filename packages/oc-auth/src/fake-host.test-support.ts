import { Effect, Exit, Layer, Option, Result, Schema } from "effect"
import FakeCatalog from "./fake-catalog.test-support.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeEvents from "./fake-events.test-support.ts"
import FakeHooks from "./fake-hooks.test-support.ts"
import FakeIntegration from "./fake-integration.test-support.ts"
import PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import type { Scope } from "effect"
import claudeAuth from "./claude-auth-plugin.ts"
import plugin from "./index.ts"

type Host = Parameters<typeof claudeAuth.setUp>[typeof FIRST]

/** The fake host's domains. */
type Domains =
  | FakeCatalog
  | FakeConnection
  | FakeEvents
  | FakeHooks
  | FakeIntegration

const FIRST = 0,
  SETTLE_YIELDS = 20,
  /* The fake host's domains, with `initial` as the active connection. */
  domains = (
    initial: Parameters<typeof FakeConnection.layer>[typeof FIRST],
  ): Layer.Layer<Domains> =>
    Layer.mergeAll(
      FakeCatalog.layer,
      FakeConnection.layer(initial),
      FakeEvents.layer,
      FakeHooks.layer,
      FakeIntegration.layer,
    ),
  /* The host the plugin is given, over the fake domains, with `options`. */
  hostWith = Effect.fn("test.hostWith")(function* hostWith(
    options: Host["options"],
  ) {
    const catalog = yield* FakeCatalog,
      connection = yield* FakeConnection,
      events = yield* FakeEvents,
      hooks = yield* FakeHooks,
      integration = yield* FakeIntegration

    return {
      event: {
        subscribe: (): ReturnType<Host["event"]["subscribe"]> => events.stream,
      },
      integration: {
        connection: connection.connection,
        transform: integration.transform,
      },
      model: catalog.catalog,
      options,
      session: { hook: hooks.hook },
    } satisfies Host
  }),
  /*
   * Start the whole plugin on the fake host with `options`, as the host
   * does, and the message of the `PluginOptionsError` it failed with. Only
   * for options that fail: valid ones go on to build the plugin's live
   * services, which read this machine's credential stores.
   */
  optionsFailure = Effect.fn("test.optionsFailure")(function* optionsFailure(
    options: Host["options"],
  ): Effect.fn.Return<Option.Option<string>, never, Domains | Scope.Scope> {
    const exit = yield* Effect.exit(plugin.effect(yield* hostWith(options)))

    return Result.getSuccess(Exit.findDefect(exit)).pipe(
      Option.filter(Schema.is(PluginOptionsError)),
      Option.map((failure: { readonly message: string }) => failure.message),
    )
  }),
  /* Set the plugin up on the fake host. */
  setUp = Effect.gen(function* setUp() {
    yield* claudeAuth.setUp(yield* hostWith({}))
    // Let the work set-up forks, such as following events, start.
    yield* Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS }))
  })

/** The fake host, setting the plugin up on it, and starting the whole plugin. */
export default Object.freeze({ domains, optionsFailure, setUp })
