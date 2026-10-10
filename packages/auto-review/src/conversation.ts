import { Array as Arr, Data, Match, pipe } from "effect"
import type { SessionMessage } from "@opencode/schema/session-message"

/** The parts of a session the reviewer reads, in this plugin's own terms. */
type ConversationItem = Data.TaggedEnum<{
  AssistantText: { readonly text: string }
  ShellCommand: { readonly command: string }
  Summary: { readonly text: string }
  ToolCall: {
    readonly id: string
    /** The call's input as JSON text. */
    readonly input: string
    readonly messageId: string
    readonly name: string
  }
  UserMessage: { readonly id: string; readonly text: string }
}>

const ConversationItem = Data.taggedEnum<ConversationItem>()

const fromToolCall = (
  messageId: string,
  part: SessionMessage.AssistantTool,
): ConversationItem =>
  ConversationItem.ToolCall({
    id: part.id,
    input: JSON.stringify(part.state.input),
    messageId,
    name: part.name,
  })

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
          tool: (tool) =>
            Match.value(tool.state).pipe(
              Match.discriminator("status")("streaming", () => []),
              Match.orElse(() => [fromToolCall(message.id, tool)]),
            ),
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

/**
 * Converts host session messages into conversation items, dropping the kinds
 * the reviewer does not read (reasoning, system updates, mode switches).
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
          shell: ({ command }) => [ConversationItem.ShellCommand({ command })],
          user: ({ id, text }) => [ConversationItem.UserMessage({ id, text })],
        }),
        Match.orElse(() => []),
      ),
    ),
  )

export { ConversationItem, fromSessionMessages }
