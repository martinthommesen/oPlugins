import { Array as Arr, Data, Match, Option, pipe } from "effect"
import type { SessionMessage } from "@opencode/schema/session-message"
import { TOOL_NAME } from "./tool-name.ts"

/** The parts of a session the advisor reads, in this plugin's own terms. */
type ConversationItem = Data.TaggedEnum<{
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

const ConversationItem = Data.taggedEnum<ConversationItem>()

type ToolContent = SessionMessage.ToolStateCompleted["content"][number]

const renderContent = (content: readonly ToolContent[]): string =>
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
  ).join("\n")

const renderToolState = (state: SessionMessage.ToolState): string =>
  Match.value(state).pipe(
    Match.discriminators("status")({
      completed: ({ content }) => renderContent(content),
      error: ({ error }) => `error: ${error.message}`,
      running: () => "<still running>",
      streaming: () => "<input still streaming>",
    }),
    Match.exhaustive,
  )

const toolInput = (state: SessionMessage.ToolState): string =>
  Match.value(state).pipe(
    Match.discriminators("status")({
      completed: ({ input }) => JSON.stringify(input),
      error: ({ input }) => JSON.stringify(input),
      running: ({ input }) => JSON.stringify(input),
      streaming: ({ input }) => input,
    }),
    Match.exhaustive,
  )

const isPending = (state: SessionMessage.ToolState): boolean =>
  Match.value(state).pipe(
    Match.discriminators("status")({
      completed: () => false,
      error: () => false,
      running: () => true,
      streaming: () => true,
    }),
    Match.exhaustive,
  )

/**
 * Converts a tool call, leaving out the advisor call being answered so the
 * advisor does not mistake its own pending consultation for the agent's work.
 * @param {SessionMessage.AssistantTool} part The tool call.
 * @returns {readonly ConversationItem[]} The call, or nothing.
 */
const fromToolCall = (
  part: SessionMessage.AssistantTool,
): readonly ConversationItem[] => {
  if (part.name === TOOL_NAME && isPending(part.state)) {
    return []
  }

  return [
    ConversationItem.ToolCall({
      input: toolInput(part.state),
      name: part.name,
      result: renderToolState(part.state),
    }),
  ]
}

const fromAssistant = (
  message: SessionMessage.Assistant,
): readonly ConversationItem[] =>
  pipe(
    message.content,
    Arr.flatMap((part: SessionMessage.AssistantContent) =>
      Match.value(part).pipe(
        Match.discriminators("type")({
          reasoning: () => [],
          text: ({ text }) => [ConversationItem.AssistantText({ text })],
          tool: fromToolCall,
        }),
        Match.exhaustive,
      ),
    ),
  )

const fromCompaction = (
  message: SessionMessage.Compaction,
): readonly ConversationItem[] =>
  Match.value(message).pipe(
    Match.discriminators("status")({
      completed: ({ summary }) => [ConversationItem.Summary({ text: summary })],
      failed: () => [],
      running: () => [],
    }),
    Match.exhaustive,
  )

const fromShell = (message: SessionMessage.Shell): ConversationItem =>
  ConversationItem.ShellCommand({
    command: message.command,
    output: Option.fromUndefinedOr(message.output).pipe(
      Option.map(({ output }) => output),
      Option.getOrElse(() => ""),
    ),
  })

/**
 * Converts host session messages into conversation items, dropping the kinds
 * the advisor does not read (reasoning, system updates, mode switches).
 * @param {readonly SessionMessage.Info[]} messages Messages from the host.
 * @returns {readonly ConversationItem[]} The items, oldest first.
 */
const fromSessionMessages = (
  messages: readonly SessionMessage.Info[],
): readonly ConversationItem[] =>
  pipe(
    messages,
    Arr.flatMap((message: SessionMessage.Info) =>
      Match.value(message).pipe(
        Match.discriminators("type")({
          assistant: fromAssistant,
          compaction: fromCompaction,
          shell: (shell) => [fromShell(shell)],
          skill: ({ name }) => [ConversationItem.SkillLoaded({ name })],
          synthetic: ({ text }) => [ConversationItem.Notice({ text })],
          user: ({ text }) => [ConversationItem.UserMessage({ text })],
        }),
        Match.orElse(() => []),
      ),
    ),
  )

export { ConversationItem, fromSessionMessages }
