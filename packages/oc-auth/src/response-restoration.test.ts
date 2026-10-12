import { Effect, Fiber, Option, Queue, Stream } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Hex } from "effect/encoding"
import responseRestoration from "./response-restoration.ts"
import support from "./request-transforms.test-support.ts"

const ALIASES = { mcp_Shell: "shell" },
  BODY_CLOSE = '"}]}',
  BODY_HEAD = '{"pad":"',
  BODY_MIDDLE = '","content":[{"type":"text","text":"',
  CREATED = 201,
  CRLF_EVENT =
    'event: content_block_start\r\ndata: {"type":"tool_use","name":"mcp_Shell"}\r\n\r\n',
  /** The fixed tail a rewrite that cut the body would keep. */
  CUT = 1024,
  /** The start of a gzip stream, which is not valid UTF-8. */
  GZIP_HEX = "1f8b0800fffe41",
  JSON_HEADERS = { "content-type": "application/json" },
  /*
   * Larger than any reasonable streaming chunk (256 KiB plus 4 KiB), so a
   * rewrite that splits the body anywhere other than an event boundary would
   * show here.
   */
  LARGE = 266_240,
  MCP_PREFIX_LENGTH = 4,
  NAME_DISTANCE = 1038,
  ONE_ASSERTION = 1,
  SPLIT_EVENTS = [
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","id":"one","na',
    'me":"mcp_Shell"}}\n\nevent: content_block_delta\ndata: {"delta":{"text":"done"}}\n\n',
  ],
  SURROGATE_DISTANCE = 1025,
  SURROGATE_END = 1023,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  ZERO_LEFT = 0,
  /* The body of `response` as bytes. */
  bodyBytes = (response: Response): Effect.Effect<Uint8Array> =>
    Option.match(Option.fromNullishOr(response.body), {
      onNone: () => Effect.succeed(new Uint8Array()),
      onSome: (body) =>
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: (cause) => cause,
        }).pipe(Stream.mkUint8Array, Effect.orDie),
    }),
  /*
   * A JSON body of `LARGE` characters in which `marker` starts
   * `distanceFromEnd` characters before the end. A rewrite that cut the body
   * while keeping a fixed 1024-character tail would cut it exactly there.
   */
  bodyEndingWith = (marker: string, distanceFromEnd: number): string => {
    const after = distanceFromEnd - marker.length - BODY_CLOSE.length,
      filler = LARGE - BODY_HEAD.length - BODY_MIDDLE.length - distanceFromEnd

    return [
      BODY_HEAD,
      "a".repeat(filler),
      BODY_MIDDLE,
      marker,
      "b".repeat(after),
      BODY_CLOSE,
    ].join("")
  },
  /* Every chunk of `response`'s body, as text, into `seen`. */
  forwardChunks = (
    response: Response,
    seen: Queue.Queue<string>,
  ): Effect.Effect<void> =>
    Option.match(Option.fromNullishOr(response.body), {
      onNone: () => Effect.void,
      onSome: (body) =>
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: (cause) => cause,
        }).pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) => Queue.offer(seen, chunk)),
          Effect.orDie,
        ),
    }),
  /* `response` restored with `ALIASES`, read whole. */
  restoredText = (response: Response): Effect.Effect<string> =>
    responseRestoration
      .restore(response, ALIASES)
      .pipe(Effect.flatMap((restored) => support.bodyText(restored))),
  /* A non-streaming response body calling the tool `name`. */
  toolUseBody = (name: string): string =>
    JSON.stringify({
      content: [{ id: "one", input: {}, name, type: "tool_use" }],
    })

describe("response restoration of streams", () => {
  it.effect("rewrites a streamed tool call split across chunks", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const text = yield* restoredText(yield* support.streamed(SPLIT_EVENTS))

      expect(text).toMatch(/"name":"shell"/u)
      expect(text).not.toMatch(/mcp_Shell/u)
      expect(text).toMatch(/"text":"done"/u)
    }),
  )

  it.effect("emits CRLF-framed events before the stream ends", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const open = yield* support.openStream,
        restored = yield* responseRestoration.restore(open.response, ALIASES),
        seen = yield* Queue.unbounded<string>(),
        tailer = yield* forwardChunks(restored, seen).pipe(Effect.forkChild),
        untilFirst = yield* open
          .push(CRLF_EVENT)
          .pipe(Effect.andThen(Queue.take(seen))),
        whenClosed = yield* open.close.pipe(
          Effect.andThen(Fiber.join(tailer)),
          Effect.andThen(Queue.size(seen)),
        )

      expect(untilFirst).toMatch(/"name":"shell"/u)
      expect(whenClosed).toBe(ZERO_LEFT)
    }),
  )
})

describe("response restoration of whole bodies", () => {
  it.effect("rewrites a non-streaming JSON body when it ends", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const call = toolUseBody("mcp_Shell"),
        restored = yield* responseRestoration.restore(
          new Response(call, {
            headers: {
              "content-length": String(call.length),
              "content-type": "application/json",
            },
          }),
          ALIASES,
        )

      expect(restored.headers.has("content-length")).toBe(false)
      expect(yield* support.bodyText(restored)).toBe(toolUseBody("shell"))
    }),
  )

  it.effect("keeps the upstream status and status text", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const restored = yield* responseRestoration.restore(
        new Response('{"name":"mcp_Shell"}', {
          headers: JSON_HEADERS,
          status: CREATED,
          statusText: "Created",
        }),
        ALIASES,
      )

      expect(restored.status).toBe(CREATED)
      expect(restored.statusText).toBe("Created")
      expect(yield* support.bodyText(restored)).toBe('{"name":"shell"}')
    }),
  )
})

describe("response restoration pass-through", () => {
  it.effect("leaves responses without aliases untouched", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const original = new Response("body", { status: 429 })

      expect(yield* responseRestoration.restore(original, {})).toBe(original)
    }),
  )

  it.effect("passes a non-text body through instead of mangling it", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      /*
       * Rewriting runs through TextDecoder, which replaces every invalid byte
       * with U+FFFD. A gzip body from a proxy must come back byte for byte.
       */
      const bytes = yield* Effect.fromResult(Hex.decode(GZIP_HEX)),
        original = new Response(new Uint8Array(bytes), {
          headers: { "content-type": "application/gzip" },
        }),
        restored = yield* responseRestoration.restore(original, ALIASES)

      expect(restored).toBe(original)
      expect(yield* bodyBytes(restored)).toStrictEqual(bytes)
    }),
  )
})

describe("response restoration of large bodies without event framing", () => {
  it.effect("never splits a tool name across two rewrites", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      // Places "mcp_" just before the cut, splitting "mcp_Shell".
      const body = bodyEndingWith('","name":"mcp_Shell","x":"', NAME_DISTANCE),
        restored = yield* restoredText(
          new Response(body, { headers: JSON_HEADERS }),
        )

      expect(body.slice(-(CUT + MCP_PREFIX_LENGTH), -CUT)).toBe("mcp_")
      expect(restored).not.toContain("mcp_Shell")
      expect(restored).toContain('"name":"shell"')
    }),
  )

  it.effect("never splits a character that spans two UTF-16 units", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const body = bodyEndingWith("🙂", SURROGATE_DISTANCE),
        restored = yield* restoredText(
          new Response(body, { headers: JSON_HEADERS }),
        )

      expect(body.slice(-SURROGATE_DISTANCE, -SURROGATE_END)).toBe("🙂")
      expect(restored).not.toContain("\uFFFD")
      expect(restored).toBe(body)
    }),
  )
})
