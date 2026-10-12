import { Effect, Fiber, Queue } from "effect"
import { describe, expect, it } from "@effect/vitest"
import responseRestoration from "./response-restoration.ts"
import support from "./request-transforms.test-support.ts"

/* Tool input that carries alias-valued `name` and `tool_name` fields. */
const ALIASED_INPUT = {
    name: "mcp_Shell",
    nested: { tool_name: "mcp_Read" },
    tool_name: "mcp_Shell",
  },
  ALIASES = { mcp_Read: "read", mcp_Shell: "shell" },
  /** Where the boundary of a split event's blank line falls. */
  BEFORE_LAST = -1,
  /** Long enough to keep a body's opening, short enough to cut its content. */
  CUT_SHORT = 40,
  FIRST_BLOCK = 0,
  JSON_HEADERS = { "content-type": "application/json" },
  /** A streamed tool call whose event data breaks off mid-object. */
  MALFORMED_EVENT =
    'event: content_block_start\ndata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"mcp_Shell"\n\n',
  /** A JSON body that names no tool of ours, laid out with spaces. */
  SECOND_BLOCK = 1,
  SPACED_BODY =
    '{ "type": "message", "content": [ { "type": "tool_use", "id": "one", "name": "mcp_Playwright_click", "input": { "name": "mcp_Shell", "tool_name": "mcp_Read" } } ] }',
  START = 0,
  /** An event type this plugin does not know, naming an alias. */
  UNKNOWN_EVENT =
    'event: tool_use\ndata: {"type":"tool_use","name":"mcp_Shell"}\n\n',
  /* A `content_block_start` event for a tool call named `name`. */
  blockStart = (name: string): string =>
    JSON.stringify({
      content_block: { id: "one", input: {}, name, type: "tool_use" },
      index: FIRST_BLOCK,
      type: "content_block_start",
    }),
  /* One SSE event of type `name` carrying `data`. */
  event = (name: string, data: string): string =>
    `event: ${name}\ndata: ${data}\n\n`,
  /* A message calling `shell` under `name`, with aliases in other fields. */
  messageCalling = (name: string): string =>
    JSON.stringify({
      content: [
        { text: "Calling mcp_Shell now", type: "text" },
        { id: "one", input: ALIASED_INPUT, name, type: "tool_use" },
      ],
      extra: { name: "mcp_Shell", tool_name: "mcp_Read" },
      type: "message",
    }),
  /* `body`, sent as JSON, restored with `ALIASES` and read whole. */
  restoredJson = (body: string): Effect.Effect<string> =>
    responseRestoration
      .restore(new Response(body, { headers: JSON_HEADERS }), ALIASES)
      .pipe(Effect.flatMap((restored) => support.bodyText(restored))),
  /* A stream arriving as `chunks`, restored with `ALIASES` and read whole. */
  restoredStream = (chunks: readonly string[]): Effect.Effect<string> =>
    support.streamed(chunks).pipe(
      Effect.flatMap((response) =>
        responseRestoration.restore(response, ALIASES),
      ),
      Effect.flatMap((restored) => support.bodyText(restored)),
    ),
  /* A tool search whose result references `reference`. */
  searchMessage = (reference: string): string =>
    JSON.stringify({
      content: [
        {
          id: "srv",
          input: { pattern: "mcp_Shell" },
          name: "mcp_Shell",
          type: "server_tool_use",
        },
        {
          content: {
            tool_references: [{ tool_name: reference, type: "tool_reference" }],
            type: "tool_search_tool_search_result",
          },
          tool_use_id: "srv",
          type: "tool_search_tool_result",
        },
      ],
      type: "message",
    }),
  /*
   * A stream calling `read` and `shell` under these names, with aliases in
   * tool inputs, an input delta, and an unknown event that stay as sent.
   */
  streamCalling = (read: string, shell: string): string =>
    [
      event(
        "message_start",
        JSON.stringify({
          message: {
            content: [
              {
                id: "zero",
                input: ALIASED_INPUT,
                name: read,
                type: "tool_use",
              },
            ],
            type: "message",
          },
          type: "message_start",
        }),
      ),
      event(
        "content_block_start",
        JSON.stringify({
          content_block: {
            id: "one",
            input: ALIASED_INPUT,
            name: shell,
            type: "tool_use",
          },
          index: SECOND_BLOCK,
          type: "content_block_start",
        }),
      ),
      event(
        "content_block_delta",
        JSON.stringify({
          delta: {
            partial_json: JSON.stringify(ALIASED_INPUT),
            type: "input_json_delta",
          },
          index: SECOND_BLOCK,
          type: "content_block_delta",
        }),
      ),
      UNKNOWN_EVENT,
    ].join("")

describe("tool names in a JSON response", () => {
  it.effect("restores a tool call's name, not the names in its input", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      expect(yield* restoredJson(messageCalling("mcp_Shell"))).toBe(
        messageCalling("shell"),
      )
    }),
  )

  it.effect("restores tool references, not server tool names", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      expect(yield* restoredJson(searchMessage("mcp_Read"))).toBe(
        searchMessage("read"),
      )
    }),
  )

  it.effect("leaves a body without a tool name of ours byte for byte", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const error = '{"type":"error","error":{"name":"mcp_Shell"}}',
        truncated = messageCalling("mcp_Shell").slice(START, CUT_SHORT)

      expect(yield* restoredJson(SPACED_BODY)).toBe(SPACED_BODY)
      expect(yield* restoredJson(error)).toBe(error)
      expect(yield* restoredJson(truncated)).toBe(truncated)
    }),
  )
})

describe("tool names in a streamed response", () => {
  it.effect("restores names only in events that carry whole blocks", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      expect(
        yield* restoredStream([streamCalling("mcp_Read", "mcp_Shell")]),
      ).toBe(streamCalling("read", "shell"))
    }),
  )

  it.effect("restores events split across chunks and data lines", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const first = event("content_block_start", blockStart("mcp_Shell")),
        restored = yield* restoredStream([
          first.slice(START, BEFORE_LAST),
          `${first.slice(BEFORE_LAST)}event: content_block_start\rdata: {"type":"content_block_start",`,
          '\rdata: "content_block":{"type":"tool_use","name":"mcp_Read"}}\r\r',
        ])

      expect(restored).toBe(
        [
          event("content_block_start", blockStart("shell")),
          'event: content_block_start\rdata: {"type":"content_block_start","content_block":{"type":"tool_use","name":"read"}}\r\r',
        ].join(""),
      )
    }),
  )
})

describe("tool names in a stream that breaks off", () => {
  it.effect("passes a malformed event on without holding back others", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const open = yield* support.openStream,
        restored = yield* responseRestoration.restore(open.response, ALIASES),
        seen = yield* Queue.unbounded<string>(),
        tailer = yield* support
          .forwardChunks(restored, seen)
          .pipe(Effect.forkChild),
        whenGood = yield* open
          .push(event("content_block_start", blockStart("mcp_Shell")))
          .pipe(Effect.andThen(Queue.take(seen))),
        whenMalformed = yield* open
          .push(MALFORMED_EVENT)
          .pipe(Effect.andThen(Queue.take(seen)))

      yield* open.close.pipe(Effect.andThen(Fiber.join(tailer)))

      expect(whenGood).toBe(event("content_block_start", blockStart("shell")))
      expect(whenMalformed).toBe(MALFORMED_EVENT)
    }),
  )
})
