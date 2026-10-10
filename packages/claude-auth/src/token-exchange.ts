import { Clock, Context, Data, Effect, Layer, Option } from "effect"
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
} from "effect/unstable/http"
import type ClaudeCredentials from "./claude-credentials.ts"
import DebugLog from "./debug-log.ts"
import type { HttpClientError } from "effect/unstable/http"
import oauthResponse from "./oauth-token-response.ts"
import policy from "./refresh-backoff-policy.ts"

/*
 * What one refresh-token exchange came to. `Transient` keeps the refresh
 * token usable and may carry the endpoint's `retry-after`; `Terminal` means
 * the refresh token itself was rejected. A network failure is `Transient`
 * with status 0.
 */
type RefreshOutcome =
  | {
      readonly _tag: "Ok"
      readonly credentials: typeof ClaudeCredentials.Type
    }
  | {
      readonly _tag: "Terminal"
      readonly oauthError: Option.Option<string>
      readonly status: number
    }
  | {
      readonly _tag: "Transient"
      readonly oauthError: Option.Option<string>
      readonly retryAfterMs: Option.Option<number>
      readonly status: number
    }

/** What is read from a token-endpoint response. */
interface EndpointResponse {
  readonly headers: Headers.Headers
  readonly status: number
  readonly text: Effect.Effect<string, HttpClientError.HttpClientError>
}

/** The parts of a token-endpoint reply an outcome is read from. */
interface Reply {
  readonly raw: string
  readonly retryAfter: Option.Option<string>
  readonly status: number
}

const NETWORK_FAILURE = 0,
  OAUTH_CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
  OAUTH_SCOPE = [
    "user:profile",
    "user:inference",
    "user:sessions:claude_code",
    "user:mcp_servers",
    "user:file_upload",
  ].join(" "),
  OAUTH_TIMEOUT_MS = 30_000,
  OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token",
  OK_FIRST = 200,
  OK_LIMIT = 300,
  Outcome = Data.taggedEnum<RefreshOutcome>(),
  makeOk = Outcome.Ok,
  makeTerminal = Outcome.Terminal,
  makeTransient = Outcome.Transient,
  /* The outcome a reply to an exchange of `refreshToken` stands for. */
  outcomeOf = Effect.fn("TokenExchange.outcomeOf")(function* outcomeOf(
    reply: Reply,
    refreshToken: string,
  ) {
    const now = yield* Clock.currentTimeMillis,
      oauthError = oauthResponse.errorCode(reply.raw)

    if (reply.status >= OK_FIRST && reply.status < OK_LIMIT) {
      return Option.match(
        oauthResponse.credentials(reply.raw, refreshToken, now),
        {
          onNone: () =>
            makeTransient({
              oauthError: Option.none(),
              retryAfterMs: Option.none(),
              status: reply.status,
            }),
          onSome: (credentials) => makeOk({ credentials }),
        },
      )
    }

    if (policy.classify(oauthError) === "terminal") {
      return makeTerminal({ oauthError, status: reply.status })
    }

    return makeTransient({
      oauthError,
      retryAfterMs: oauthResponse.retryAfterMs(reply.retryAfter, now),
      status: reply.status,
    })
  }),
  /*
   * Network failures, timeouts, and aborts all end here. The logged error
   * name tells them apart, and tells them from a bug.
   */
  requestFailed = Effect.fn("TokenExchange.requestFailed")(
    function* requestFailed(failure: {
      readonly message: string
      readonly name: string
    }) {
      const log = yield* DebugLog

      yield* log.log("refresh_request_failed", {
        error: failure.message,
        errorName: failure.name,
      })

      return makeTransient({
        oauthError: Option.none(),
        retryAfterMs: Option.none(),
        status: NETWORK_FAILURE,
      })
    },
  ),
  /* Exchange `refreshToken` at the token endpoint for fresh credentials. */
  runExchange = Effect.fn("TokenExchange.exchange")(function* runExchange(
    refreshToken: string,
  ) {
    const client = yield* HttpClient.HttpClient,
      request = HttpClientRequest.post(OAUTH_TOKEN_URL).pipe(
        HttpClientRequest.bodyJsonUnsafe({
          client_id: OAUTH_CLIENT_ID,
          grant_type: "refresh_token",
          refresh_token: refreshToken,
          scope: OAUTH_SCOPE,
        }),
      )

    return yield* client.execute(request).pipe(
      // The token endpoint gets the request as written, without trace headers.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.flatMap((response: EndpointResponse) =>
        response.text.pipe(
          Effect.map((raw) => ({
            raw,
            retryAfter: Headers.get(response.headers, "retry-after"),
            status: response.status,
          })),
        ),
      ),
      Effect.flatMap((reply: Reply) => outcomeOf(reply, refreshToken)),
      Effect.timeout(OAUTH_TIMEOUT_MS),
      Effect.catchTags({
        HttpClientError: (failure: {
          readonly reason: { readonly message: string; readonly name: string }
        }) => requestFailed(failure.reason),
        TimeoutError: (failure: {
          readonly message: string
          readonly name: string
        }) => requestFailed(failure),
      }),
    )
  })

/**
 * The OAuth token endpoint: trades a refresh token for fresh credentials.
 * Every failure becomes an outcome; nothing is left in the error channel.
 */
class TokenExchange extends Context.Service<
  TokenExchange,
  {
    /** Exchange `refreshToken` for fresh credentials, once, within 30 seconds. */
    readonly exchange: (refreshToken: string) => Effect.Effect<RefreshOutcome>
  }
>()("oclaude/token-exchange/TokenExchange") {
  /** Builds and matches the outcomes `exchange` returns. */
  public static readonly Outcome = Outcome

  /** How long one exchange may take, request and response together. */
  public static readonly timeoutMs = OAUTH_TIMEOUT_MS

  /** The exchange over a given `HttpClient`. */
  public static readonly layerWithClient: Layer.Layer<
    TokenExchange,
    never,
    DebugLog | HttpClient.HttpClient
  > = Layer.effect(
    TokenExchange,
    Effect.gen(function* makeTokenExchange() {
      const context = yield* Effect.context<DebugLog | HttpClient.HttpClient>()

      return TokenExchange.of({
        exchange: (refreshToken) =>
          runExchange(refreshToken).pipe(Effect.provideContext(context)),
      })
    }),
  )

  /** The live exchange, over `fetch`. */
  public static readonly layer: Layer.Layer<TokenExchange, never, DebugLog> =
    TokenExchange.layerWithClient.pipe(Layer.provide(FetchHttpClient.layer))
}

export default TokenExchange
