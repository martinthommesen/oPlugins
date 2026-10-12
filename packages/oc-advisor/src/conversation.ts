import { Array as Arr, Data, Match, Option, pipe } from "effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import TOOL_NAME from "./tool-name.ts"

/** The parts of a session the advisor reads, in this plugin's own terms. */
type Item = Data.TaggedEnum<{
  AssistantText: { readonly text: string }
  Notice: { readonly text: string }
  ShellCommand: { readonly command: string; readonly output: string }
  SkillLoaded: { readonly name: string }
  Summary: { readonly text: string }
  ToolCall: {
    /** The call's input as JSON text. */
    readonly input: string
    readonly name: string
    /** What the tool returned, or why it has not. */
    readonly result: string
  }
  UserMessage: { readonly text: string }
}>

type ToolContent = SessionMessage.ToolStateCompleted["content"][number]

const ConversationItem = Data.taggedEnum<Item>(),
  contentText = (content: readonly ToolContent[]): string =>
    pipe(
      content,
      Arr.map((part) =>
        Match.value(part).pipe(
          Match.discriminators("type")({
            file: ({ mime, name, uri }) => `[file ${name ?? uri} (${mime})]`,
            text: ({ text }) => text,
          }),
          Match.exhaustive,
        ),
      ),
    ).join("\n"),
  inputJson = (state: SessionMessage.ToolState): string =>
    Match.value(state).pipe(
      Match.discriminators("status")({
        completed: ({ input }) => JSON.stringify(input),
        error: ({ input }) => JSON.stringify(input),
        running: ({ input }) => JSON.stringify(input),
        streaming: ({ input }) => input,
      }),
      Match.exhaustive,
    ),
  isPending = (state: SessionMessage.ToolState): boolean =>
    Match.value(state).pipe(
      Match.discriminators("status")({
        completed: () => false,
        error: () => false,
        running: () => true,
        streaming: () => true,
      }),
      Match.exhaustive,
    ),
  resultText = (state: SessionMessage.ToolState): string =>
    Match.value(state).pipe(
      Match.discriminators("status")({
        completed: ({ content }) => contentText(content),
        error: ({ error }) => `error: ${error.message}`,
        running: () => "<still running>",
        streaming: () => "<input still streaming>",
      }),
      Match.exhaustive,
    ),
  shellItem = (message: SessionMessage.Shell): Item =>
    ConversationItem.ShellCommand({
      command: message.command,
      output: Option.fromUndefinedOr(message.output).pipe(
        Option.map(({ output }) => output),
        Option.getOrElse(() => ""),
      ),
    }),
  summaryItems = (message: SessionMessage.Compaction): readonly Item[] =>
    Match.value(message).pipe(
      Match.discriminators("status")({
        completed: ({ summary }) => [
          ConversationItem.Summary({ text: summary }),
        ],
        failed: () => [],
        running: () => [],
      }),
      Match.exhaustive,
    ),
  /*
   * Converts a tool call, leaving out the advisor call being answered so the
   * advisor does not mistake its own pending consultation for the agent's work.
   */
  toolItems = (part: SessionMessage.AssistantTool): readonly Item[] => {
    if (part.name === TOOL_NAME && isPending(part.state)) {
      return []
    }

    return [
      ConversationItem.ToolCall({
        input: inputJson(part.state),
        name: part.name,
        result: resultText(part.state),
      }),
    ]
  },
  turnItems = (message: SessionMessage.Assistant): readonly Item[] =>
    pipe(
      message.content,
      Arr.flatMap((part: SessionMessage.AssistantContent) =>
        Match.value(part).pipe(
          Match.discriminators("type")({
            reasoning: () => [],
            text: ({ text }) => [ConversationItem.AssistantText({ text })],
            tool: toolItems,
          }),
          Match.exhaustive,
        ),
      ),
    ),
  /*
   * Converts host session messages into conversation items. It drops what
   * the advisor does not read: reasoning, system messages, idle markers, and
   * agent, model, and location switches.
   */
  visibleItems = (messages: readonly SessionMessage.Info[]): readonly Item[] =>
    pipe(
      messages,
      Arr.flatMap((message: SessionMessage.Info) =>
        Match.value(message).pipe(
          Match.discriminators("type")({
            assistant: turnItems,
            compaction: summaryItems,
            shell: (shell) => [shellItem(shell)],
            skill: ({ name }) => [ConversationItem.SkillLoaded({ name })],
            synthetic: ({ text }) => [ConversationItem.Notice({ text })],
            user: ({ text }) => [ConversationItem.UserMessage({ text })],
          }),
          Match.orElse(() => []),
        ),
      ),
    )

/** A session's conversation, as the advisor reads it. */
export default Object.freeze({
  ConversationItem,
  fromSessionMessages: visibleItems,
})
