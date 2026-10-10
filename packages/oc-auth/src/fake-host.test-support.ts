import { Effect, Layer } from "effect"
import FakeCatalog from "./fake-catalog.test-support.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeEvents from "./fake-events.test-support.ts"
import FakeHooks from "./fake-hooks.test-support.ts"
import FakeIntegration from "./fake-integration.test-support.ts"
import claudeAuth from "./claude-auth-plugin.ts"

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
  /* Set the plugin up on the fake host, with `options`. */
  setUpWith = (
    options: Host["options"],
  ): Effect.Effect<
    void,
    never,
    Domains | Effect.Services<ReturnType<typeof claudeAuth.setUp>>
  > =>
    Effect.gen(function* setUp() {
      yield* claudeAuth.setUp(yield* hostWith(options))
      // Let the work set-up forks, such as following events, start.
      yield* Effect.yieldNow.pipe(Effect.repeat({ times: SETTLE_YIELDS }))
    })

/** The fake host, and setting the plugin up on it. */
export default Object.freeze({
  domains,
  setUp: setUpWith(Object.freeze({})),
  setUpWith,
})
