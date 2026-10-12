import { Effect, Layer, Option, Ref, Schema } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import type { HttpClientError, HttpClientRequest } from "effect/http"
import ClaudeCodeStores from "#src/claude-code-stores.ts"
import CredentialRefresh from "#src/credential-refresh.ts"
import PluginOptions from "#src/plugin-options.ts"
import RefreshBackoff from "#src/refresh-backoff.ts"
import RefreshLock from "#src/refresh-lock.ts"
import TokenExchange from "#src/token-exchange.ts"
import testEnvironment from "#src/test-environment.test-support.ts"

type Account = Effect.Success<
  ClaudeCodeStores["Service"]["readAccounts"]
>[number]

/** Where a refresh of the sandbox's copy runs, and what it reaches. */
interface Rig {
  /** The request bodies the fake token endpoint received, in order. */
  readonly bodies: Ref.Ref<readonly string[]>
  /** The sandbox's Claude Code config directory. */
  readonly configDir: string
  /** The sandbox root, which also holds the refresh locks. */
  readonly root: string
}

// The real account's refresh token, which only its own store may spend.
const ACCOUNT_REFRESH = "account-refresh",
  /** A request body held in memory. */
  BytesBody = Schema.Struct({ body: Schema.Uint8Array }),
  HOUR_MS = 3_600_000,
  REJECTED = 400,
  ROTATED = 200,
  ROTATED_LIFETIME_S = 28_800,
  UTF8 = new TextDecoder(),
  /** A real Claude Code account, as its own credential store holds it. */
  account: Account = {
    configDir: "/home/someone/.claude",
    credentials: {
      accessToken: "account-access",
      expiresAt: HOUR_MS,
      refreshToken: ACCOUNT_REFRESH,
      subscriptionType: "pro",
    },
    label: "Claude Pro: someone@example.com",
    source: "file",
  },
  /*
   * The token endpoint's answer to `body`, as Anthropic's would be: it
   * rotates only a refresh token it issued, and rejects any other.
   */
  answer = (body: string): Response => {
    if (!body.includes(ACCOUNT_REFRESH)) {
      return Response.json({ error: "invalid_grant" }, { status: REJECTED })
    }

    return Response.json(
      {
        access_token: "rotated-access",
        expires_in: ROTATED_LIFETIME_S,
        refresh_token: "rotated-refresh",
      },
      { status: ROTATED },
    )
  },
  /* Record the body of `request` in `bodies`, and answer it. */
  answered = (
    bodies: Ref.Ref<readonly string[]>,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  > => {
    const body = Schema.decodeUnknownOption(BytesBody)(request.body).pipe(
        Option.match({
          onNone: () => "",
          onSome: (bytes) => UTF8.decode(bytes.body),
        }),
      ),
      reply = HttpClientResponse.fromWeb(request, answer(body))

    return Ref.update(bodies, (sent) => [...sent, body]).pipe(Effect.as(reply))
  },
  /* The fake token endpoint, recording each request's body in `bodies`. */
  endpoint = (
    bodies: Ref.Ref<readonly string[]>,
  ): Layer.Layer<HttpClient.HttpClient> =>
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.makeWith(
        (incoming: Effect.Effect<HttpClientRequest.HttpClientRequest>) =>
          incoming.pipe(Effect.flatMap((request) => answered(bodies, request))),
        Effect.succeed,
      ),
    ),
  /*
   * The plugin's credential refresh, which a 401's recovery and the host's
   * refresh callback both reach, over the sandbox's credentials file on
   * Linux and the fake token endpoint, built in the caller's scope.
   */
  refreshIn = Effect.fn("test.refreshIn")(function* refreshIn(rig: Rig) {
    const base = Layer.mergeAll(
        testEnvironment({
          CLAUDE_CONFIG_DIR: rig.configDir,
          HOME: rig.root,
          OC_AUTH_REFRESH_LOCK_DIR: rig.root,
        })("linux"),
        endpoint(rig.bodies),
        PluginOptions.layer({}),
      ),
      parts = Layer.mergeAll(
        ClaudeCodeStores.layer,
        RefreshBackoff.layer,
        RefreshLock.layer,
        TokenExchange.layerWithClient,
      ).pipe(Layer.provideMerge(base))

    return yield* Layer.build(
      CredentialRefresh.layer.pipe(Layer.provideMerge(parts)),
    )
  }, Effect.orDie),
  /* Stores holding only `account`, for the copy to read. */
  stores = Layer.succeed(
    ClaudeCodeStores,
    ClaudeCodeStores.of({
      readAccounts: Effect.succeed([account]),
      readSource: () => Effect.die("the copy reads only the account list"),
      writeBack: () => Effect.die("the copy never writes the account back"),
    }),
  )

/** A real account to copy, and the plugin's refresh over the copy. */
/** @internal */
export default Object.freeze({
  ACCOUNT_REFRESH,
  account,
  refreshIn,
  stores,
})
