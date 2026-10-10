import { Array as Arr, Effect, Option, Schema, Struct } from "effect"
import type {
  SessionContext,
  SessionTitle,
} from "@opencode/plugin/effect/session"
import PluginOptions from "./plugin-options.ts"
import claudeHeaders from "./claude-headers.ts"
import signing from "./signing.ts"
import toolAliases from "./tool-aliases.ts"

type ContextMessage = SessionContext["messages"][number]

type ContextPart = ContextMessage["content"][number]

/* Marks the message this plugin relocated a system prompt into. */
const CONTEXT_METADATA_KEY = "martinthommesen.oc-auth",
  LEADING_NEWLINES = /^\n+/u,
  PARAGRAPH = "\n\n",
  /** A text part this plugin moved into the first user message. */
  RelocatedPart = Schema.Struct({
    metadata: Schema.Struct({ [CONTEXT_METADATA_KEY]: Schema.Literal(true) }),
    type: Schema.Literal("text"),
  }),
  SYSTEM_IDENTITY = "You are Claude Code, Anthropic's official CLI for Claude.",
  TextPart = Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("text"),
  }),
  UserMessage = Schema.Struct({ role: Schema.Literal("user") }),
  /* The content of the first user message, if there is one. */
  firstUserContent = (
    event: SessionContext | SessionTitle,
    opening: Option.Option<number>,
  ): readonly ContextPart[] =>
    opening.pipe(
      Option.flatMap((index) => Arr.get(event.messages, index)),
      Option.map(Struct.get("content")),
      Option.getOrElse((): readonly ContextPart[] => []),
    ),
  /*
   * The text of the first user message's first text part, skipping what this
   * plugin relocated there, as Claude Code's billing extraction selects it.
   */
  firstUserText = (
    event: SessionContext | SessionTitle,
    opening: Option.Option<number>,
  ): string => {
    for (const part of firstUserContent(event, opening)) {
      if (Schema.is(TextPart)(part) && !Schema.is(RelocatedPart)(part)) {
        return part.text
      }
    }

    return ""
  },
  /*
   * Move `text` into the first user message as a marked part, unless an
   * earlier turn already did. The message type marks `content` read-only, so
   * the message is replaced.
   */
  insertRelocated = (
    event: SessionContext | SessionTitle,
    opening: Option.Option<number>,
    text: string,
  ): void => {
    const marked: ContextPart = {
        metadata: { [CONTEXT_METADATA_KEY]: true },
        text,
        type: "text",
      },
      message = opening.pipe(
        Option.flatMap((index) => Arr.get(event.messages, index)),
      )

    if (
      text === "" ||
      Option.isNone(opening) ||
      Option.isNone(message) ||
      message.value.content.some(Schema.is(RelocatedPart))
    ) {
      return
    }

    event.messages[opening.value] = Struct.assign(message.value, {
      content: [marked, ...message.value.content],
    })
  },
  /* `text`, unless it is empty. */
  keptText = (text: string): readonly string[] =>
    [text].filter((kept) => kept !== ""),
  /*
   * The system text to relocate: everything except this plugin's own billing
   * header and identity, with text that followed the identity in its part
   * kept.
   */
  movedText = (event: SessionContext | SessionTitle): readonly string[] =>
    event.system.flatMap((part) => {
      if (part.text.startsWith(signing.prefix)) {
        return []
      }

      if (part.text.startsWith(SYSTEM_IDENTITY)) {
        return keptText(
          part.text.slice(SYSTEM_IDENTITY.length).replace(LEADING_NEWLINES, ""),
        )
      }

      return keptText(part.text)
    }),
  /* The names of the tools the session registers; a title request has none. */
  registeredTools = (
    event: SessionContext | SessionTitle,
  ): readonly string[] => {
    if ("tools" in event) {
      return Object.keys(event.tools)
    }

    return []
  },
  /*
   * The text relocated into the first user message: the moved system text,
   * then the tool-name mapping so the model can relate instructions that use
   * OpenCode names to the tools it is offered.
   */
  relocatedText = (
    moved: readonly string[],
    aliases: readonly (readonly [string, string])[],
  ): string => {
    const guidance = aliases.map(([name, alias]) => `${name} -> ${alias}`)

    return [
      ...moved,
      ...Arr.match(guidance, {
        onEmpty: () => [],
        onNonEmpty: (pairs) => [
          `Tool names in these instructions map as follows: ${pairs.join(", ")}.`,
        ],
      }),
    ].join(PARAGRAPH)
  },
  /*
   * Rewrite the session context for subscription billing: `system` becomes
   * the billing header and Claude Code's identity, and everything else moves
   * into the first user message. Returns the aliases the registered tools
   * will carry on the wire, so a response can be restored even when its
   * request state is unavailable.
   */
  rewriteContext = Effect.fn("SessionContext.rewrite")(function* rewrite(
    event: SessionContext | SessionTitle,
  ) {
    const aliases = toolAliases.build(registeredTools(event)),
      moved = movedText(event),
      opening = Arr.findFirstIndex(event.messages, Schema.is(UserMessage)),
      options = yield* PluginOptions,
      relocation = relocatedText(moved, aliases),
      signature = yield* signing.billingHeader(
        firstUserText(event, opening),
        claudeHeaders.cliVersion(options),
        claudeHeaders.entrypoint(options),
      )

    insertRelocated(event, opening, relocation)
    event.system = [
      { text: signature, type: "text" },
      { text: SYSTEM_IDENTITY, type: "text" },
      ...Option.match(opening, {
        onNone: () => moved.map((text) => ({ text, type: "text" as const })),
        onSome: () => [],
      }),
    ]

    return toolAliases.invert(aliases)
  })

/** The session context rewrite subscription billing needs. */
export default Object.freeze({
  rewrite: rewriteContext,
  systemIdentity: SYSTEM_IDENTITY,
})
