import { Data, Effect, Option, Schema, Struct } from "effect"
import type { HttpBody } from "effect/unstable/http"
import { HttpServerResponse } from "effect/unstable/http"

/** What the mock answers: a call of the read tool, or text. */
type ReplyKind = Data.TaggedEnum<{
  ReadCall: { readonly path: string }
  Text: { readonly text: string }
}>

/** The parts of a reply that differ between a tool call and text. */
interface ReplyParts {
  readonly block: typeof ContentBlock.Type
  readonly delta: typeof StreamDelta.Type
  /** The block as a stream opens it, before any delta. */
  readonly opening: typeof ContentBlock.Type
  readonly stopReason: string
}

const BLOCK_INDEX = 0,
  BlockText = Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("text"),
  }),
  BlockToolUse = Schema.Struct({
    id: Schema.String,
    input: Schema.Record(Schema.String, Schema.String),
    name: Schema.String,
    type: Schema.Literal("tool_use"),
  }),
  ContentBlock = Schema.Union([BlockText, BlockToolUse]),
  Counts = Schema.Struct({
    input_tokens: Schema.Number,
    output_tokens: Schema.Number,
  }),
  DeltaJson = Schema.Struct({
    partial_json: Schema.String,
    type: Schema.Literal("input_json_delta"),
  }),
  DeltaText = Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("text_delta"),
  }),
  INPUT_TOKENS = 10,
  MESSAGE_ID = "msg_mock",
  /** A Messages API response; `null` stop fields are none. */
  Message = Schema.Struct({
    content: Schema.Array(ContentBlock),
    id: Schema.String,
    model: Schema.String,
    role: Schema.Literal("assistant"),
    stop_reason: Schema.OptionFromNullOr(Schema.String),
    stop_sequence: Schema.OptionFromNullOr(Schema.String),
    type: Schema.Literal("message"),
    usage: Counts,
  }),
  NO_TOKENS = 0,
  OUTPUT_TOKENS = 10,
  READ_ALIAS = "mcp_Read",
  Reply = Data.taggedEnum<ReplyKind>(),
  StopDelta = Schema.Struct({
    stop_reason: Schema.OptionFromNullOr(Schema.String),
    stop_sequence: Schema.OptionFromNullOr(Schema.String),
  }),
  StreamDelta = Schema.Union([DeltaJson, DeltaText]),
  /** One server-sent event of a streamed Messages API response. */
  StreamEvent = Schema.Union([
    Schema.Struct({ message: Message, type: Schema.Literal("message_start") }),
    Schema.Struct({
      content_block: ContentBlock,
      index: Schema.Number,
      type: Schema.Literal("content_block_start"),
    }),
    Schema.Struct({
      delta: StreamDelta,
      index: Schema.Number,
      type: Schema.Literal("content_block_delta"),
    }),
    Schema.Struct({
      index: Schema.Number,
      type: Schema.Literal("content_block_stop"),
    }),
    Schema.Struct({
      delta: StopDelta,
      type: Schema.Literal("message_delta"),
      usage: Schema.Struct({ output_tokens: Schema.Number }),
    }),
    Schema.Struct({ type: Schema.Literal("message_stop") }),
  ]),
  StreamEventJson = Schema.fromJsonString(StreamEvent),
  TOOL_CALL_ID = "tool_mock_read",
  /* The complete response message for `parts`. */
  bodyOf = (model: string, parts: ReplyParts): typeof Message.Type => ({
    content: [parts.block],
    id: MESSAGE_ID,
    model,
    role: "assistant",
    stop_reason: Option.some(parts.stopReason),
    stop_sequence: Option.none(),
    type: "message",
    usage: { input_tokens: INPUT_TOKENS, output_tokens: OUTPUT_TOKENS },
  }),
  /* One server-sent event: its type, then its JSON data. */
  encodeEvent = (
    event: typeof StreamEvent.Type,
  ): Effect.Effect<string, Schema.SchemaError> =>
    Schema.encodeEffect(StreamEventJson)(event).pipe(
      Effect.map((data) => `event: ${event.type}\ndata: ${data}\n\n`),
    ),
  /* The events that stream the response message for `parts`. */
  eventsOf = (
    model: string,
    parts: ReplyParts,
  ): readonly (typeof StreamEvent.Type)[] => [
    {
      message: Struct.assign(bodyOf(model, parts), {
        content: [],
        stop_reason: Option.none(),
        usage: { input_tokens: INPUT_TOKENS, output_tokens: NO_TOKENS },
      }),
      type: "message_start",
    },
    {
      content_block: parts.opening,
      index: BLOCK_INDEX,
      type: "content_block_start",
    },
    { delta: parts.delta, index: BLOCK_INDEX, type: "content_block_delta" },
    { index: BLOCK_INDEX, type: "content_block_stop" },
    {
      delta: {
        stop_reason: Option.some(parts.stopReason),
        stop_sequence: Option.none(),
      },
      type: "message_delta",
      usage: { output_tokens: OUTPUT_TOKENS },
    },
    { type: "message_stop" },
  ],
  /* The parts of a reply that differ between a tool call and text. */
  partsOf = Reply.$match({
    ReadCall: ({ path }): ReplyParts => ({
      block: {
        id: TOOL_CALL_ID,
        input: { path },
        name: READ_ALIAS,
        type: "tool_use",
      },
      delta: {
        partial_json: JSON.stringify({ path }),
        type: "input_json_delta",
      },
      opening: {
        id: TOOL_CALL_ID,
        input: {},
        name: READ_ALIAS,
        type: "tool_use",
      },
      stopReason: "tool_use",
    }),
    Text: ({ text }): ReplyParts => ({
      block: { text, type: "text" },
      delta: { text, type: "text_delta" },
      opening: { text: "", type: "text" },
      stopReason: "end_turn",
    }),
  }),
  /* `reply` as one JSON response. */
  respondJson = (
    reply: ReplyKind,
    model: string,
  ): Effect.Effect<
    HttpServerResponse.HttpServerResponse,
    HttpBody.HttpBodyError
  > => HttpServerResponse.schemaJson(Message)(bodyOf(model, partsOf(reply))),
  /* `reply` as a server-sent event stream, written in one piece. */
  respondStream = (
    reply: ReplyKind,
    model: string,
  ): Effect.Effect<HttpServerResponse.HttpServerResponse, Schema.SchemaError> =>
    Effect.forEach(eventsOf(model, partsOf(reply)), (event) =>
      encodeEvent(event),
    ).pipe(
      Effect.map((chunks: readonly string[]) =>
        HttpServerResponse.text(chunks.join(""), {
          contentType: "text/event-stream",
        }),
      ),
    )

/** The mock's replies, as Messages API responses. */
export default Object.freeze({
  json: respondJson,
  readCall: Reply.ReadCall,
  stream: respondStream,
  text: Reply.Text,
})
