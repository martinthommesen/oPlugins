import { Brand, Effect, Layer, Struct } from "effect"
import CredentialRefresh from "./credential-refresh.ts"
import FakeConnection from "./fake-connection.test-support.ts"
import FakeHooks from "./fake-hooks.test-support.ts"
import PluginRig from "./plugin-rig.test-support.ts"
import type { SessionHttpResponse } from "@opencode/plugin/effect/session"
import claudeCodeCredential from "./claude-code-credential.ts"
import fakeHost from "./fake-host.test-support.ts"
import pluginServices from "./plugin-services.test-support.ts"
import transformsSupport from "./request-transforms.test-support.ts"

type Script = Parameters<typeof PluginRig.layer>[typeof FIRST]

type Accounts = Parameters<typeof PluginRig.layer>[typeof SECOND]

type Active = Parameters<typeof FakeConnection.layer>[typeof FIRST]

type Options = Parameters<ReturnType<typeof pluginServices>>[typeof SECOND]

type Refresh = Effect.Success<ReturnType<Script["refresh"]>>

/** Everything a plugin scenario provides. */
type Scenario =
  | Layer.Success<ReturnType<ReturnType<typeof pluginServices>>>
  | Layer.Success<ReturnType<typeof fakeHost.domains>>

/** A 401 that counts how many times its body is released. */
interface Releasable {
  readonly released: () => number
  readonly response: Response
}

const FIRST = 0,
  MODEL = "claude-sonnet-4-5",
  ONE = 1,
  SECOND = 1,
  UNAUTHORIZED = 401,
  ZERO = 0,
  /* A Messages API request that `signal` can abort. */
  abortable = (signal: AbortSignal): Request =>
    new Request("https://api.anthropic.com/v1/messages", {
      body: "body",
      method: "POST",
      signal,
    }),
  /* A Claude Code account in `source`, holding `access`. */
  account = (source: string, access: string): Accounts[typeof FIRST] => ({
    credentials: {
      accessToken: access,
      expiresAt: Number.MAX_SAFE_INTEGER,
      refreshToken: `refresh-${access}`,
    },
    label: `Claude Pro: ${source}`,
    source,
  }),
  /* What a refresh came to: `access` adopted from the store. */
  adopted = (access: string): Refresh =>
    CredentialRefresh.Result.Adopted({
      credential: PluginRig.credential(access),
    }),
  asSession = Brand.nominal<SessionHttpResponse["sessionID"]>(),
  /* The OpenCode credential this plugin imported, holding `access`. */
  imported = (
    access: string,
  ): ReturnType<typeof claudeCodeCredential.toOAuth> =>
    claudeCodeCredential.toOAuth(PluginRig.credential(access)),
  /* A Messages API request carrying `body`. */
  messages = (body = "request-body"): Request =>
    new Request("https://api.anthropic.com/v1/messages", {
      body,
      method: "POST",
    }),
  /*
   * The plugin with `options` on a host whose active connection is
   * `active`, over `script`.
   */
  onConfiguredHost =
    (options: Options) =>
    (
      active: Active,
      script: Script = PluginRig.quiet,
      accounts: Accounts = [],
    ): Layer.Layer<Scenario> =>
      Layer.merge(
        pluginServices(script)(accounts, options),
        fakeHost.domains(active),
      ),
  /* The plugin on a host whose active connection is `active`, over `script`. */
  onHost = onConfiguredHost({}),
  /* A host whose active connection is this plugin's credential for `access`. */
  ours = (access: string): Active => FakeConnection.oauth(access),
  /* What a refresh came to: `access` renewed by the endpoint. */
  refreshed = (access: string): Refresh =>
    CredentialRefresh.Result.Refreshed({
      credential: PluginRig.credential(access),
    }),
  /* A 401 that counts how many times its body is released. */
  releasable = (): Releasable => {
    let released = ZERO

    return {
      released: () => released,
      response: new Response(
        new ReadableStream({
          cancel: (): void => {
            released += ONE
          },
        }),
        { status: UNAUTHORIZED },
      ),
    }
  },
  /*
   * Answer `request` with `response` through the response hook, in
   * `session`, and the response the caller gets.
   */
  respond = (
    request: Request,
    response: Response,
    session = "session",
  ): Effect.Effect<Response, never, FakeHooks> =>
    Effect.gen(function* answer() {
      const event: SessionHttpResponse = Struct.assign(
        transformsSupport.httpEvent(request, MODEL),
        { response, sessionID: asSession(session) },
      )

      yield* (yield* FakeHooks).fire("http.response", event)

      return event.response
    }),
  /*
   * Answer `request` with `response` through the response hook, for a model
   * call of `kind`, and the response the caller gets.
   */
  respondAs = Effect.fn("test.respondAs")(function* respondAs(
    kind: SessionHttpResponse["kind"],
    request: Request,
    response: Response,
  ) {
    const event: SessionHttpResponse = Struct.assign(
      transformsSupport.httpEvent(request, MODEL),
      { kind, response },
    )

    yield* (yield* FakeHooks).fire("http.response", event)

    return event.response
  }),
  /* Send `request` through the request hook, and the request that goes out. */
  send = Effect.fn("test.send")(function* send(request: Request) {
    const event = transformsSupport.httpEvent(request, MODEL)

    yield* (yield* FakeHooks).fire("http.request", event)

    return event.request
  }),
  /* The plain 401 the API answers with. */
  unauthorized = (): Response =>
    new Response("unauthorized", { status: UNAUTHORIZED })

/** What the plugin scenarios share. */
export default Object.freeze({
  abortable,
  account,
  adopted,
  contextEvent: transformsSupport.contextEvent,
  imported,
  messages,
  onConfiguredHost,
  onHost,
  ours,
  refreshed,
  releasable,
  respond,
  respondAs,
  send,
  unauthorized,
})
