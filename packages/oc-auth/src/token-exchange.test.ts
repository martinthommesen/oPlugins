import type { Config, Scope } from "effect"
import { Context, Effect, Fiber, Layer, Option, Path, Schema } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import DebugLog from "./debug-log.ts"
import { TestClock } from "effect/testing"
import TokenEndpoint from "./token-endpoint.test-support.ts"
import TokenExchange from "./token-exchange.ts"
import type { Vitest } from "@effect/vitest"
import logSupport from "./debug-log.test-support.ts"
import testEnvironment from "./test-environment.test-support.ts"

/** The `it` of a `test.layer` block giving the debug log's platform. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof logSupport.layer> | Scope.Scope
  >
}

/** The `it` of a `test.layer` block giving an exchange and its endpoint. */
interface ExchangeTests {
  readonly effect: Vitest.Test<Scope.Scope | TokenEndpoint | TokenExchange>
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

type Outcome = Effect.Success<ReturnType<TokenExchange["Service"]["exchange"]>>

type SentRequest = Effect.Success<TokenEndpoint["Service"]["requests"]>[number]

/** An outcome reduced to plain fields, for comparison. */
interface Summary {
  readonly kind: string
  readonly oauthError: Option.Option<string>
  readonly retryAfterMs: Option.Option<number>
  readonly status: number
}

// The test clock's time for every exchange: 2026-01-01T00:00:00Z.
const AT = 1_767_225_600_000,
  BAD_REQUEST = 400,
  DATE_HINT_MS = 30_000,
  DEFAULT_VARIABLES = { HOME: "/nonexistent-home" },
  Json = Schema.fromJsonString(Schema.Unknown),
  NETWORK_FAILURE = 0,
  OK = 200,
  ONE_ASSERTION = 1,
  RATE_LIMITED = 429,
  SECONDS_HINT_MS = 7000,
  SERVER_ERROR = 503,
  THREE_ASSERTIONS = 3,
  TIMEOUT_MS = 30_000,
  TOKEN_URL = "https://platform.claude.com/v1/oauth/token",
  TWO_ASSERTIONS = 2,
  /* An exchange whose endpoint answers `reply`, logging per `variables`. */
  exchangeLayer = (
    reply: Effect.Effect<Response, string>,
    variables: Readonly<Record<string, string>> = DEFAULT_VARIABLES,
  ): Layer.Layer<
    TokenEndpoint | TokenExchange,
    Config.ConfigError,
    Layer.Success<typeof logSupport.layer>
  > => {
    const log = DebugLog.layer.pipe(Layer.provide(testEnvironment(variables)))

    return TokenExchange.layerWithClient.pipe(
      Layer.provideMerge(TokenEndpoint.layer(reply)),
      Layer.provide(log),
    )
  },
  /* The endpoint answering `status` with the JSON `body`. */
  failing = (status: number, body: string): Effect.Effect<Response> =>
    Effect.sync(() => new Response(body, { status })),
  /* The endpoint answering 429 with the given `retry-after`. */
  rateLimited = (retryAfter: string): Effect.Effect<Response> =>
    Effect.sync(
      () =>
        new Response('{"error":"rate_limit_error"}', {
          headers: { "retry-after": retryAfter },
          status: RATE_LIMITED,
        }),
    ),
  /* The endpoint issuing fresh tokens. */
  successfulResponse = Effect.sync(() =>
    Response.json({
      access_token: "new-access",
      expires_in: 3600,
      refresh_token: "new-refresh",
    }),
  ),
  /* `outcome` as plain fields; an `Ok` reads as status 200. */
  summary = (outcome: Outcome): Summary =>
    TokenExchange.Outcome.$match(outcome, {
      Ok: () => ({
        kind: "ok",
        oauthError: Option.none(),
        retryAfterMs: Option.none(),
        status: OK,
      }),
      Terminal: (terminal) => ({
        kind: "terminal",
        oauthError: terminal.oauthError,
        retryAfterMs: Option.none(),
        status: terminal.status,
      }),
      Transient: (transient) => ({
        kind: "transient",
        oauthError: transient.oauthError,
        retryAfterMs: transient.retryAfterMs,
        status: transient.status,
      }),
    }),
  /* Exchange `token` once through an exchange `layer` builds, then release it. */
  throughLayer = <Requirements>(
    layer: Layer.Layer<TokenExchange, Config.ConfigError, Requirements>,
    token: string,
  ): Effect.Effect<Summary, Config.ConfigError, Requirements> =>
    Layer.build(layer).pipe(
      Effect.flatMap((context) =>
        Context.get(context, TokenExchange).exchange(token),
      ),
      Effect.map((outcome) => summary(outcome)),
      Effect.scoped,
    ),
  /* Exchange "refresh-token" with the endpoint answering `reply`. */
  tryExchange = (
    reply: Effect.Effect<Response, string>,
  ): Effect.Effect<Summary, Config.ConfigError> =>
    throughLayer(
      exchangeLayer(reply).pipe(Layer.provide(logSupport.layer)),
      "refresh-token",
    ),
  /* Exchange with the endpoint rate limiting with the given `retry-after`. */
  whenThrottled = (
    retryAfter: string,
  ): Effect.Effect<Summary, Config.ConfigError> =>
    tryExchange(rateLimited(retryAfter)),
  /* What `sent` put on the wire, with its JSON body decoded. */
  wireOf = (sent: SentRequest): readonly unknown[] => [
    sent.method,
    sent.url,
    sent.contentType,
    Schema.decodeUnknownOption(Json)(sent.body),
  ]

test.layer(
  exchangeLayer(successfulResponse).pipe(Layer.provide(logSupport.layer)),
)("token exchange request", (it: ExchangeTests) => {
  it.effect("uses the platform JSON contract exactly once", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const exchange = yield* TokenExchange,
        outcome = summary(yield* exchange.exchange("refresh-token")),
        requests = yield* (yield* TokenEndpoint).requests,
        wire = requests.map((sent) => wireOf(sent))

      expect(outcome.kind).toBe("ok")
      expect(wire).toStrictEqual([
        [
          "POST",
          TOKEN_URL,
          Option.some("application/json"),
          Option.some({
            client_id: "9d1c250a-e61b-44d9-88ed-5944d1962f5e",
            grant_type: "refresh_token",
            refresh_token: "refresh-token",
            scope:
              "user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
          }),
        ],
      ])
    }),
  )
})

test.layer(Layer.empty)("token exchange rejections", (it: PureTests) => {
  it.effect("reads retry-after as seconds or as an HTTP date", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const date = yield* TestClock.setTime(AT).pipe(
          Effect.andThen(whenThrottled("Thu, 01 Jan 2026 00:00:30 GMT")),
        ),
        garbage = yield* whenThrottled("soon"),
        seconds = yield* whenThrottled("7")

      expect(seconds.retryAfterMs).toStrictEqual(Option.some(SECONDS_HINT_MS))
      expect(date.retryAfterMs).toStrictEqual(Option.some(DATE_HINT_MS))
      expect(garbage.retryAfterMs).toStrictEqual(Option.none())
    }),
  )
})

describe("token exchange failure kinds", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("treats a rejected refresh token as terminal", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        expect(
          yield* tryExchange(failing(BAD_REQUEST, '{"error":"invalid_grant"}')),
        ).toStrictEqual({
          kind: "terminal",
          oauthError: Option.some("invalid_grant"),
          retryAfterMs: Option.none(),
          status: BAD_REQUEST,
        })
      }),
    )
  })

  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("reads an OAuth error nested under its type", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        expect(
          yield* tryExchange(
            failing(SERVER_ERROR, '{"error":{"type":"overloaded_error"}}'),
          ),
        ).toStrictEqual({
          kind: "transient",
          oauthError: Option.some("overloaded_error"),
          retryAfterMs: Option.none(),
          status: SERVER_ERROR,
        })
      }),
    )
  })
})

test.layer(Layer.empty)(
  "token exchange success without credentials",
  (it: PureTests) => {
    it.effect("treats an unusable success body as transient", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        expect(
          yield* tryExchange(failing(OK, '{"access_token":"a"}')),
        ).toStrictEqual({
          kind: "transient",
          oauthError: Option.none(),
          retryAfterMs: Option.none(),
          status: OK,
        })
      }),
    )
  },
)

describe("token exchange network failures", () => {
  test.layer(logSupport.layer)((it: Tests) => {
    it.effect("turns a failed request into a logged transient failure", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const home = yield* logSupport.sandbox,
          path = (yield* Path.Path).join(home, "exchange.log"),
          recordedLayer = exchangeLayer(Effect.fail("fetch failed"), {
            CLAUDE_AUTH_DEBUG: path,
            HOME: home,
          }),
          result = yield* throughLayer(recordedLayer, "token"),
          written = yield* logSupport.readRecords(path)

        expect(result).toStrictEqual({
          kind: "transient",
          oauthError: Option.none(),
          retryAfterMs: Option.none(),
          status: NETWORK_FAILURE,
        })
        expect(written.map((record) => record.event)).toStrictEqual([
          "refresh_request_failed",
        ])
      }),
    )
  })

  test.layer(Layer.empty)((it: PureTests) => {
    it.effect(
      "gives up on an endpoint that does not answer in 30 seconds",
      () =>
        Effect.gen(function* run() {
          expect.assertions(ONE_ASSERTION)

          const pending = yield* Effect.forkChild(tryExchange(Effect.never))

          yield* TestClock.adjust(TIMEOUT_MS)

          expect((yield* Fiber.join(pending)).status).toBe(NETWORK_FAILURE)
        }),
    )
  })
})
