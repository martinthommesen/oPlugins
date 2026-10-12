import { Effect, Layer } from "effect"
import ActiveCredential from "#src/active-credential.ts"
import AnthropicFetch from "#src/anthropic-fetch.ts"
import type FakeConnection from "#src/fake-connection.test-support.ts"
import RequestStates from "#src/request-states.ts"
import RequestTransforms from "#src/request-transforms.ts"
import SessionAliases from "#src/session-aliases.ts"
import type copy from "./headless-credentials.test-support.ts"
import fakeHost from "#src/fake-host.test-support.ts"

type Active = Parameters<typeof FakeConnection.layer>[typeof FIRST]

type Refreshing = Effect.Success<ReturnType<typeof copy.refreshIn>>

const FIRST = 0,
  UNAUTHORIZED = 401,
  /* The API, rejecting every access token, as it does one it revoked. */
  api = Layer.succeed(
    AnthropicFetch,
    AnthropicFetch.of({
      send: () =>
        Effect.succeed(new Response("unauthorized", { status: UNAUTHORIZED })),
    }),
  ),
  /*
   * The whole plugin set up on a fake host whose active connection is
   * `active`, over `refreshing`, the plugin's own credential refresh, built
   * in the caller's scope. Only the API is fake: every replay gets a 401.
   */
  pluginOver = Effect.fn("test.pluginOver")(function* pluginOver(
    refreshing: Refreshing,
    active: Active,
  ) {
    const context = Layer.succeedContext(refreshing),
      services = yield* Layer.mergeAll(
        ActiveCredential.layer,
        RequestStates.layer,
        RequestTransforms.layer,
        SessionAliases.layer,
        api,
        fakeHost.domains(active),
      ).pipe(Layer.provideMerge(context), Layer.build)

    yield* fakeHost.setUp.pipe(Effect.provideContext(services))

    return services
  })

/** The whole plugin on a fake host, over a credential refresh of the caller's. */
/** @internal */
export default Object.freeze({ over: pluginOver })
