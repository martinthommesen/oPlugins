import { Array as Arr, Match, Option, Predicate, Schema, Struct } from "effect"
import toolAliases from "./tool-aliases.ts"

/** A decoded JSON value. Schema's own `Json` hides its arrays behind an interface. */
type Json = boolean | number | string | null | readonly Json[] | JsonObject

/** A decoded JSON object. */
interface JsonObject {
  readonly [key: string]: Json
}

/** Maps each alias this plugin applied back to the OpenCode tool name. */
type OriginalByAlias = Readonly<Record<string, string>>

const BlockStart = Schema.Struct({
    type: Schema.Literal("content_block_start"),
  }),
  JsonText = Schema.fromJsonString(Schema.Json),
  Message = Schema.Struct({ type: Schema.Literal("message") }),
  MessageStart = Schema.Struct({ type: Schema.Literal("message_start") }),
  ToolReference = Schema.Struct({
    tool_name: Schema.String,
    type: Schema.Literal("tool_reference"),
  }),
  ToolUse = Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("tool_use"),
  }),
  /* `record` with `rewrite` applied at `key`, or `record` itself when that changed nothing. */
  fieldRewritten = (
    record: JsonObject,
    key: string,
    rewrite: (value: Json) => Json,
  ): JsonObject =>
    Option.fromUndefinedOr(record[key]).pipe(
      Option.flatMap((current) =>
        Option.liftPredicate(rewrite(current), (next) => next !== current),
      ),
      Option.match({
        onNone: () => record,
        onSome: (next) => Struct.assign(record, { [key]: next }),
      }),
    ),
  guardArray = (value: Json): value is readonly Json[] => Arr.isArray(value),
  guardObject = (value: Json): value is JsonObject => Predicate.isObject(value),
  /* `items` with `rewrite` applied, or `items` itself when no item changed. */
  keptMap = (
    items: readonly Json[],
    rewrite: (item: Json) => Json,
  ): readonly Json[] => {
    const mapped = items.map((item) => rewrite(item))

    if (mapped.every((item, index) => item === items[index])) {
      return items
    }

    return mapped
  },
  /* The OpenCode name for `value`, when it is an alias this plugin applied. */
  nameRestored = (value: Json, aliases: OriginalByAlias): Json => {
    if (!Predicate.isString(value)) {
      return value
    }

    return toolAliases.original(value, aliases)
  },
  /*
   * `value` with the tool name of every tool reference restored. Tool-search
   * results carry their references under `content` and `tool_references`, so
   * only those fields are followed; a block's `input`, text, and every other
   * field are left alone.
   */
  referencesRestored = (value: Json, aliases: OriginalByAlias): Json => {
    if (guardArray(value)) {
      return keptMap(value, (item) => referencesRestored(item, aliases))
    }

    if (!guardObject(value)) {
      return value
    }

    if (Schema.is(ToolReference)(value)) {
      return fieldRewritten(value, "tool_name", (name) =>
        nameRestored(name, aliases),
      )
    }

    return fieldRewritten(
      fieldRewritten(value, "content", (nested) =>
        referencesRestored(nested, aliases),
      ),
      "tool_references",
      (nested) => referencesRestored(nested, aliases),
    )
  },
  /*
   * A content block with its tool names restored: a `tool_use` block's name,
   * and the tool references in a tool-search result. Server tool blocks keep
   * the names Anthropic gave them, because this plugin never aliases those.
   */
  restoreBlock = (block: Json, aliases: OriginalByAlias): Json => {
    if (guardObject(block) && Schema.is(ToolUse)(block)) {
      return fieldRewritten(block, "name", (name) =>
        nameRestored(name, aliases),
      )
    }

    return referencesRestored(block, aliases)
  },
  /* A Messages API message with the tool names in its content restored. */
  restoreMessage = (message: Json, aliases: OriginalByAlias): Json => {
    if (!guardObject(message) || !Schema.is(Message)(message)) {
      return message
    }

    return fieldRewritten(message, "content", (content) => {
      if (!guardArray(content)) {
        return content
      }

      return keptMap(content, (block) => restoreBlock(block, aliases))
    })
  },
  /*
   * A streamed event with its tool names restored. Only the events that
   * carry whole content blocks name a tool; deltas carry tool input as
   * escaped text, and pass with every other event as they came.
   */
  restoreStreamEvent = (event: JsonObject, aliases: OriginalByAlias): Json =>
    Match.value(event).pipe(
      Match.when(Schema.is(MessageStart), () =>
        fieldRewritten(event, "message", (message) =>
          restoreMessage(message, aliases),
        ),
      ),
      Match.when(Schema.is(BlockStart), () =>
        fieldRewritten(event, "content_block", (block) =>
          restoreBlock(block, aliases),
        ),
      ),
      Match.orElse(() => event),
    ),
  /*
   * `text`, a JSON object, rewritten by `restore`, as JSON; none when it is
   * not a JSON object or no tool name changed, so the caller keeps the
   * original text byte for byte.
   */
  restoredText = (
    text: string,
    restore: (payload: JsonObject) => Json,
  ): Option.Option<string> =>
    Schema.decodeOption(JsonText)(text).pipe(
      Option.filter((value: Json) => guardObject(value)),
      Option.flatMap((payload) =>
        Option.liftPredicate(restore(payload), (next) => next !== payload),
      ),
      Option.map((next) => JSON.stringify(next)),
    ),
  /* The data of one streamed event with its tool names restored, if any changed. */
  toolNamesInEvent = (
    data: string,
    aliases: OriginalByAlias,
  ): Option.Option<string> =>
    restoredText(data, (event) => restoreStreamEvent(event, aliases)),
  /* A whole JSON response with its tool names restored, if any changed. */
  toolNamesInMessage = (
    text: string,
    aliases: OriginalByAlias,
  ): Option.Option<string> =>
    restoredText(text, (message) => restoreMessage(message, aliases))

/** Restoring tool names in the fields of a response that name a tool. */
export default Object.freeze({
  inEvent: toolNamesInEvent,
  inMessage: toolNamesInMessage,
})
