import {
  Effect,
  Exit,
  Fiber,
  Latch,
  Layer,
  Option,
  Scope,
  Stream,
} from "effect"
import { HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http"
import { NodeHttpServer, NodeHttpServerRequest } from "@effect/platform-node"
import { describe, expect, it as test } from "@effect/vitest"
import AnthropicFetch from "./anthropic-fetch.ts"
import type AnthropicFetchError from "./anthropic-fetch-error.ts"
import type { Vitest } from "@effect/vitest"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Layer.Success<typeof local> | Scope.Scope>
}

/** What the local API saw of the request it was sent. */
interface Seen {
  /** Opens when the client goes away before the response ends. */
  readonly abandoned: Latch.Latch
  /** Opens when the request arrives. */
  readonly received: Latch.Latch
}

const LONG_BODY_LENGTH = 16_000_000,
  LOOPBACK = "127.0.0.1",
  /* A turn its caller cancels with `cancel`. */
  callerTurn = Effect.gen(function* callerTurn() {
    const caller = yield* Scope.make()

    return {
      cancel: Scope.close(caller, Exit.void),
      signal: yield* Effect.abortSignal.pipe(Scope.provide(caller)),
    }
  }),
  /* The real `AnthropicFetch` over the runtime's `fetch`, and a local API. */
  local = Layer.merge(AnthropicFetch.layer, NodeHttpServer.layerTest),
  /* A local API whose body is far longer than one read, so most is to come. */
  long = Effect.succeed(HttpServerResponse.text("x".repeat(LONG_BODY_LENGTH))),
  /* Read `response` to its end, opening `started` at its first chunk. */
  readAll = (
    response: Response,
    started: Latch.Latch,
  ): Effect.Effect<"ended" | "stopped"> =>
    Option.match(Option.fromNullishOr(response.body), {
      onNone: () => Effect.succeed("ended" as const),
      onSome: (body) =>
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: (cause) => cause,
        }).pipe(
          Stream.runForEach(() => started.open),
          Effect.match({
            onFailure: () => "stopped" as const,
            onSuccess: () => "ended" as const,
          }),
        ),
    }),
  /* Serve `api` locally, and a Messages API request to it that `turn` aborts. */
  requestTo = Effect.fn("test.requestTo")(function* requestTo(
    api: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest
    >,
    turn: AbortSignal,
  ) {
    const server = yield* HttpServer.HttpServer,
      url = new URL("/v1/messages", HttpServer.formatAddress(server.address))

    yield* server.serve(api)
    url.hostname = LOOPBACK

    return new Request(url, { body: "body", method: "POST", signal: turn })
  }),
  /* Latches for what the local API sees. */
  seeing = Effect.all({
    abandoned: Latch.make(false),
    received: Latch.make(false),
  }),
  /* Send `request` through the real `AnthropicFetch`. */
  send = (
    request: Request,
  ): Effect.Effect<Response, AnthropicFetchError, AnthropicFetch> =>
    AnthropicFetch.pipe(Effect.flatMap((fetch) => fetch.send(request))),
  /* Serve `api` locally, and send it a request that `turn` aborts. */
  sentTo = (
    api: Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      never,
      HttpServerRequest.HttpServerRequest
    >,
    turn: AbortSignal,
  ): Effect.Effect<
    Response,
    AnthropicFetchError,
    AnthropicFetch | HttpServer.HttpServer | Scope.Scope
  > => requestTo(api, turn).pipe(Effect.flatMap((request) => send(request))),
  /*
   * A local API that answers only once its client went away, recording what
   * it sees in `seen`.
   */
  silent = Effect.fn("test.silent")(function* silent(seen: Seen) {
    NodeHttpServerRequest.toServerResponse(
      yield* HttpServerRequest.HttpServerRequest,
    ).once("close", () => {
      seen.abandoned.openUnsafe()
    })
    yield* seen.received.open
    yield* seen.abandoned.await

    return HttpServerResponse.text("")
  })

describe("a replay whose turn was cancelled before it", () => {
  test.layer(local)((it: Tests) => {
    it.effect("never goes out", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const seen = yield* seeing,
          sending = yield* Effect.exit(
            sentTo(silent(seen), AbortSignal.abort()),
          )

        expect(Exit.isFailure(sending)).toBe(true)
        expect(seen.received.isOpen()).toBe(false)
      }),
    )
  })
})

describe("a replay whose turn is cancelled", () => {
  test.layer(local)((it: Tests) => {
    it.effect("is aborted while it waits for the response", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const caller = yield* callerTurn,
          seen = yield* seeing,
          waiting = yield* Effect.forkChild(sentTo(silent(seen), caller.signal))

        yield* seen.received.await
        yield* caller.cancel

        expect(Exit.isFailure(yield* Fiber.await(waiting))).toBe(true)
        // The local API sees the connection close.
        yield* seen.abandoned.await
        expect(seen.abandoned.isOpen()).toBe(true)
      }),
    )
  })

  test.layer(local)((it: Tests) => {
    it.effect("stops its body while it streams", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const caller = yield* callerTurn,
          firstChunk = yield* Latch.make(false),
          reply = yield* sentTo(long, caller.signal),
          streamed = yield* Effect.forkChild(readAll(reply, firstChunk))

        yield* firstChunk.await
        yield* caller.cancel

        // Without the turn's signal, the rest of the body would still arrive.
        expect(yield* Fiber.join(streamed)).toBe("stopped")
      }),
    )
  })
})

describe("a replay whose send is interrupted", () => {
  test.layer(local)((it: Tests) => {
    it.effect("is aborted", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const seen = yield* seeing,
          sending = yield* Effect.forkChild(
            sentTo(silent(seen), yield* Effect.abortSignal),
          )

        yield* seen.received.await
        yield* Fiber.interrupt(sending)
        // The local API sees the connection close.
        yield* seen.abandoned.await

        expect(seen.abandoned.isOpen()).toBe(true)
      }),
    )
  })
})
