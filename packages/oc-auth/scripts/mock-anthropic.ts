import { Context, Effect, Layer, Option, Ref, Struct } from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import type { HttpBody } from "effect/http"
import MockAnthropicError from "./mock-anthropic-error.ts"
import { NodeHttpServer } from "@effect/platform-node"
import type { Schema } from "effect"
import replies from "./mock-anthropic-reply.ts"
import requests from "./mock-anthropic-request.ts"

/** What the read tool is sent to read, and what the file holds. */
interface Fixture {
  readonly file: string
  readonly sentinel: string
}

/** What the mock has seen, for `verify`. */
interface Seen {
  /** Why each rejected request was rejected. */
  readonly failures: Ref.Ref<readonly string[]>
  readonly toolCalls: Ref.Ref<number>
  readonly toolResults: Ref.Ref<number>
}

/** One request that passed the checks. */
interface Exchange {
  /** Whether the agent loop sent it, rather than a title request. */
  readonly primary: boolean
  readonly turn: typeof requests.MessageRequest.Type
}

type Reply =
  | ReturnType<typeof replies.text>
  | ReturnType<typeof replies.readCall>

const BAD_REQUEST = 400,
  LOOPBACK = "127.0.0.1",
  NEXT = 1,
  NONE = 0,
  OFFLINE_TEXT = "Offline smoke test",
  /*
   * The base URL the plugin is pointed at. The test server listens on every
   * interface; the plugin reaches it over loopback.
   */
  baseUrlOf = (address: string): string => {
    const url = new URL(address)

    url.hostname = LOOPBACK

    return new URL("/v1", url).href
  },
  /* Fail with `failures`, unless there are none. */
  check = (
    failures: readonly string[],
  ): Effect.Effect<void, MockAnthropicError> => {
    if (failures.length === NONE) {
      return Effect.void
    }

    return Effect.fail(
      MockAnthropicError.make({ message: failures.join("; ") }),
    )
  },
  /* Whether the plugin's test hook marked the request as the agent loop's. */
  fromPrimary = (sent: typeof requests.WireHeaders.Type): boolean =>
    sent["x-claude-auth-test-kind"] === "primary",
  /*
   * Decode and check the current request. The headers are checked before
   * the body is read, and a request that fails to decode is rejected too.
   */
  inspect = Effect.fn("MockAnthropic.inspect")(
    function* inspect(sentinel: string) {
      const request = yield* HttpServerRequest.HttpServerRequest,
        route = HttpServerRequest.toURL(request).pipe(
          Option.map(Struct.get("pathname")),
        ),
        sent = yield* HttpServerRequest.schemaHeaders(requests.WireHeaders),
        turn = yield* check(requests.headerFailures(sent, route)).pipe(
          Effect.andThen(
            HttpServerRequest.schemaBodyJson(requests.MessageRequest),
          ),
        )

      yield* check(requests.bodyFailures(turn, fromPrimary(sent), sentinel))

      return { primary: fromPrimary(sent), turn }
    },
    Effect.catchTags({
      HttpServerError: (failure: { readonly message: string }) =>
        Effect.fail(MockAnthropicError.make({ message: failure.message })),
      SchemaError: (failure: { readonly message: string }) =>
        Effect.fail(MockAnthropicError.make({ message: failure.message })),
    }),
  ),
  /* Record why a request was rejected, and answer it as the API would. */
  reject = (
    seen: Seen,
    failure: { readonly message: string },
  ): Effect.Effect<HttpServerResponse.HttpServerResponse> =>
    Ref.update(seen.failures, (all) => [...all, failure.message]).pipe(
      Effect.as(
        HttpServerResponse.jsonUnsafe(
          {
            error: { message: failure.message, type: "invalid_request_error" },
            type: "error",
          },
          { status: BAD_REQUEST },
        ),
      ),
    ),
  /*
   * Count the tool round trip and choose the reply: the agent loop's first
   * request gets a read call, its follow-up gets the sentinel, and anything
   * else gets plain text.
   */
  replyTo = Effect.fn("MockAnthropic.replyTo")(function* replyTo(
    seen: Seen,
    exchange: Exchange,
    fixture: Fixture,
  ) {
    const returned =
        requests.blocksOfType(exchange.turn.messages, "tool_result").length >
        NONE,
      toolCall = exchange.primary && !returned

    yield* Ref.update(seen.toolCalls, (count) => count + NEXT).pipe(
      Effect.when(Effect.succeed(toolCall)),
    )
    yield* Ref.update(seen.toolResults, (count) => count + NEXT).pipe(
      Effect.when(Effect.succeed(exchange.primary && returned)),
    )

    if (toolCall) {
      return replies.readCall({ path: fixture.file })
    }

    if (exchange.primary) {
      return replies.text({ text: fixture.sentinel })
    }

    return replies.text({ text: OFFLINE_TEXT })
  }),
  /*
   * Every request the mock rejected, and whether the tool round trip
   * reached it in both directions.
   */
  report = Effect.fn("MockAnthropic.verify")(function* report(seen: Seen) {
    const failures = yield* Ref.get(seen.failures),
      toolCalls = yield* Ref.get(seen.toolCalls),
      toolResults = yield* Ref.get(seen.toolResults)

    yield* check(failures.map((failure) => `rejected a request: ${failure}`))

    yield* Effect.fail(
      MockAnthropicError.make({ message: "no tool call reached the mock" }),
    ).pipe(Effect.when(Effect.succeed(toolCalls === NONE)))
    yield* Effect.fail(
      MockAnthropicError.make({ message: "no tool result reached the mock" }),
    ).pipe(Effect.when(Effect.succeed(toolResults === NONE)))
  }),
  /* `reply` in the form the request asked for. */
  respond = (
    exchange: Exchange,
    reply: Reply,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpBody.HttpBodyError | Schema.SchemaError
  > => {
    if (exchange.turn.stream === true) {
      return replies.stream(reply, exchange.turn.model)
    }

    return replies.json(reply, exchange.turn.model)
  },
  /* Check the current request and answer it. */
  respondTo = Effect.fn("MockAnthropic.respondTo")(function* respondTo(
    seen: Seen,
    fixture: Fixture,
  ) {
    const exchange = yield* inspect(fixture.sentinel),
      reply = yield* replyTo(seen, exchange, fixture)

    return yield* respond(exchange, reply)
  }),
  /* Answer the current request; a rejected one is recorded for `verify`. */
  serveTurn = (
    seen: Seen,
    fixture: Fixture,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpBody.HttpBodyError | Schema.SchemaError,
    HttpServerRequest.HttpServerRequest
  > =>
    respondTo(seen, fixture).pipe(
      Effect.catchTag(
        "MockAnthropicError",
        (failure: { readonly message: string }) => reject(seen, failure),
      ),
    ),
  /*
   * Local Messages API fixture: never contacts Anthropic or reads
   * credentials. It serves until the enclosing scope closes; `verify` fails
   * when it rejected any request or never saw the read tool's round trip.
   */
  start = Effect.fn("MockAnthropic.start")(function* start(
    sentinel: string,
    file: string,
  ) {
    const context = yield* Layer.build(NodeHttpServer.layerTest),
      seen = {
        failures: yield* Ref.make<readonly string[]>([]),
        toolCalls: yield* Ref.make(NONE),
        toolResults: yield* Ref.make(NONE),
      },
      server = Context.get(context, HttpServer.HttpServer)

    yield* server.serve(serveTurn(seen, { file, sentinel }))

    return {
      baseURL: baseUrlOf(HttpServer.formatAddress(server.address)),
      verify: report(seen),
    }
  })

/** The mock Messages API the offline smoke test points the plugin at. */
/** @internal */
export default Object.freeze({ start })
