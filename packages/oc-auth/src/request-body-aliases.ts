import {
  Array as Arr,
  HashMap,
  Match,
  Option,
  Predicate,
  Schema,
  Struct,
} from "effect"
import toolAliases from "./tool-aliases.ts"

/** A decoded JSON value. Schema's own `Json` hides its arrays behind an interface. */
type Json = boolean | number | string | null | readonly Json[] | JsonObject

/** A decoded JSON object. */
interface JsonObject {
  readonly [key: string]: Json
}

/** A request body with its tool names aliased. */
interface AliasedBody {
  /** The body to send. */
  readonly body: Uint8Array<ArrayBuffer>
  /** The model the body names, read before anything is rewritten. */
  readonly model: Option.Option<string>
  /** The aliases applied, so the response stream can restore the original names. */
  readonly originalByAlias: Readonly<Record<string, string>>
}

const CustomTool = Schema.Struct({ type: Schema.Literal("custom") }),
  JsonText = Schema.fromJsonString(Schema.Json),
  NamedTool = Schema.Struct({ name: Schema.String }),
  /** A tool with a `type` of its own: a server tool, unless that is `custom`. */
  ServerTool = Schema.Struct({ type: Schema.String }),
  ToolChoice = Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("tool"),
  }),
  ToolReference = Schema.Struct({
    tool_name: Schema.String,
    type: Schema.Literal("tool_reference"),
  }),
  ToolUse = Schema.Struct({
    name: Schema.String,
    type: Schema.Literal("tool_use"),
  }),
  guardArray = (value: Json): value is readonly Json[] => Arr.isArray(value),
  guardObject = (value: Json): value is JsonObject => Predicate.isObject(value),
  /* Server tools keep the exact name Anthropic defines for their `type`. */
  isClientTool = (tool: JsonObject): boolean =>
    !Schema.is(ServerTool)(tool) || Schema.is(CustomTool)(tool),
  /* The array at `key` in `record`, or none. */
  itemsAt = (record: JsonObject, key: string): Option.Option<readonly Json[]> =>
    Option.fromNullishOr(record[key]).pipe(
      Option.filter((value) => guardArray(value)),
    ),
  /* The objects in the array at `key` in `record`. */
  listObjects = (record: JsonObject, key: string): readonly JsonObject[] =>
    Option.getOrElse(itemsAt(record, key), (): readonly Json[] => []).filter(
      (item) => guardObject(item),
    ),
  /* The names of the client tools the request offers. */
  listedTools = (payload: JsonObject): readonly string[] =>
    listObjects(payload, "tools").flatMap((tool) => {
      if (isClientTool(tool) && Schema.is(NamedTool)(tool)) {
        return [tool.name]
      }

      return []
    }),
  /* `value` with `rewrite` applied to each item, when it is an array. */
  mapItems = (value: Json, rewrite: (item: Json) => Json): Json => {
    if (!guardArray(value)) {
      return value
    }

    return value.map((item) => rewrite(item))
  },
  /* The tool a forced `tool_choice` names. */
  namedChoice = (payload: JsonObject): readonly string[] =>
    Option.fromNullishOr(payload["tool_choice"]).pipe(
      Option.filter((choice) => guardObject(choice)),
      Option.filter((choice) => Schema.is(ToolChoice)(choice)),
      Option.map((choice) => choice.name),
      Option.toArray,
    ),
  /* The JSON object `text` holds, or none. */
  parsePayload = (text: string): Option.Option<JsonObject> =>
    Schema.decodeOption(JsonText)(text).pipe(
      Option.filter((value: Json) => guardObject(value)),
    ),
  /* The tools the conversation history called. */
  pastToolUses = (payload: JsonObject): readonly string[] =>
    listObjects(payload, "messages").flatMap((message) =>
      listObjects(message, "content").flatMap((block) => {
        if (Schema.is(ToolUse)(block)) {
          return [block.name]
        }

        return []
      }),
    ),
  /*
   * Tool-search results reference deferred client tools inside content
   * blocks. Tool inputs and arbitrary JSON results are not traversed.
   */
  referenceName = (block: JsonObject): readonly string[] => {
    if (Schema.is(ToolReference)(block)) {
      return [block.tool_name]
    }

    return []
  },
  referencedTools = (record: JsonObject): readonly string[] =>
    listObjects(record, "content").flatMap((block) =>
      Arr.appendAll(referenceName(block), referencedTools(block)),
    ),
  /* `record` with the tool name in `field` replaced by its alias, if any. */
  renameField = (
    record: JsonObject,
    field: "name" | "tool_name",
    aliases: HashMap.HashMap<string, string>,
  ): JsonObject => {
    const current = record[field]

    if (!Predicate.isString(current)) {
      return record
    }

    return Option.match(HashMap.get(aliases, current), {
      onNone: () => record,
      onSome: (alias) => Struct.assign(record, { [field]: alias }),
    })
  },
  /*
   * `block` with its tool names aliased: a `tool_use` name at the top level
   * of a message, and tool references at any depth of nested content.
   */
  rewriteBlock = (
    block: Json,
    aliases: HashMap.HashMap<string, string>,
    topLevel: boolean,
  ): Json => {
    if (!guardObject(block)) {
      return block
    }

    const renamed = Match.value(block).pipe(
      Match.when(Schema.is(ToolReference), () =>
        renameField(block, "tool_name", aliases),
      ),
      Match.when(
        (candidate) => topLevel && Schema.is(ToolUse)(candidate),
        () => renameField(block, "name", aliases),
      ),
      Match.orElse(() => block),
    )

    return Option.match(itemsAt(renamed, "content"), {
      onNone: () => renamed,
      onSome: (content) =>
        Struct.assign(renamed, {
          content: content.map((nested) =>
            rewriteBlock(nested, aliases, false),
          ),
        }),
    })
  },
  /* A forced `tool_choice` with its tool aliased. */
  rewriteChoice = (
    choice: Json,
    aliases: HashMap.HashMap<string, string>,
  ): Json => {
    if (guardObject(choice) && Schema.is(ToolChoice)(choice)) {
      return renameField(choice, "name", aliases)
    }

    return choice
  },
  /* A message with the tool names in its content aliased. */
  rewriteMessage = (
    message: Json,
    aliases: HashMap.HashMap<string, string>,
  ): Json => {
    if (!guardObject(message)) {
      return message
    }

    return Option.match(itemsAt(message, "content"), {
      onNone: () => message,
      onSome: (content) =>
        Struct.assign(message, {
          content: content.map((block) => rewriteBlock(block, aliases, true)),
        }),
    })
  },
  /* A tool definition with its name aliased, unless it is a server tool. */
  rewriteTool = (
    tool: Json,
    aliases: HashMap.HashMap<string, string>,
  ): Json => {
    if (guardObject(tool) && isClientTool(tool)) {
      return renameField(tool, "name", aliases)
    }

    return tool
  },
  /* The value at `key` of a request body with its tool names aliased. */
  rewriteTopLevel = (
    key: string,
    value: Json,
    aliases: HashMap.HashMap<string, string>,
  ): Json =>
    Match.value(key).pipe(
      Match.when("tools", () =>
        mapItems(value, (tool) => rewriteTool(tool, aliases)),
      ),
      Match.when("tool_choice", () => rewriteChoice(value, aliases)),
      Match.when("messages", () =>
        mapItems(value, (message) => rewriteMessage(message, aliases)),
      ),
      Match.orElse(() => value),
    ),
  textDecoder = new TextDecoder(),
  textEncoder = new TextEncoder(),
  /*
   * Every name in a Messages API body that names a tool the model may call,
   * in the order aliases are assigned: offered tools, the forced choice,
   * called tools, then tool references.
   */
  toolNames = (payload: JsonObject): readonly string[] => [
    ...listedTools(payload),
    ...namedChoice(payload),
    ...pastToolUses(payload),
    ...listObjects(payload, "messages").flatMap((message) =>
      referencedTools(message),
    ),
  ],
  /* `payload` with every tool name in `aliases` replaced by its alias. */
  usingAliases = (
    payload: JsonObject,
    aliases: readonly (readonly [string, string])[],
  ): JsonObject => {
    const byName = HashMap.fromIterable(aliases)

    return Object.fromEntries(
      Object.entries(payload).map(([key, value]: readonly [string, Json]) => [
        key,
        rewriteTopLevel(key, value, byName),
      ]),
    )
  },
  /* `body`, which holds `payload`, with its tool names aliased. */
  viaAliases = (
    body: Uint8Array<ArrayBuffer>,
    payload: JsonObject,
  ): AliasedBody => {
    const aliases = toolAliases.build(toolNames(payload)),
      model = Option.fromNullishOr(payload["model"]).pipe(
        Option.filter((value) => Predicate.isString(value)),
      )

    if (Arr.isReadonlyArrayEmpty(aliases)) {
      return { body, model, originalByAlias: {} }
    }

    return {
      body: textEncoder.encode(JSON.stringify(usingAliases(payload, aliases))),
      model,
      originalByAlias: toolAliases.invert(aliases),
    }
  },
  /*
   * Rewrite the outbound `/v1/messages` body to Claude Code tool names. A
   * body with nothing to alias is returned as it came, byte for byte. None
   * when the body is not a JSON object.
   */
  wireBody = (body: Uint8Array<ArrayBuffer>): Option.Option<AliasedBody> =>
    parsePayload(textDecoder.decode(body)).pipe(
      Option.map((payload) => viaAliases(body, payload)),
    )

/** Aliasing the tool names in a Messages API request body. */
export default Object.freeze({ alias: wireBody })
