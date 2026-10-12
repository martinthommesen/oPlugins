import { Array as Arr, Match, pipe } from "effect"
import ConversationItem from "./conversation-item.ts"
import type { SessionMessage } from "@opencode/schema/session-message"

type Item = Parameters<typeof ConversationItem.$match>[typeof FIRST]

const FIRST = 0,
  /* A tool call whose input has finished streaming, with that input as JSON text. */
  calledTool = (messageId: string, part: SessionMessage.AssistantTool): Item =>
    ConversationItem.ToolCall({
      id: part.id,
      input: JSON.stringify(part.state.input),
      messageId,
      name: part.name,
    }),
  /*
   * The text and tool calls of an assistant message. A call still streaming
   * its input is left out, because that input is incomplete.
   */
  fromAssistant = (message: SessionMessage.Assistant): readonly Item[] =>
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
                Match.orElse(() => [calledTool(message.id, tool)]),
              ),
          }),
          Match.exhaustive,
        ),
      ),
    ),
  /* The summary of a completed compaction. */
  fromCompaction = (message: SessionMessage.Compaction): readonly Item[] =>
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
   * Converts host session messages into conversation items, oldest first.
   * The reviewer reads user messages, shell commands, assistant text and
   * tool calls, and compaction summaries; every other kind is dropped.
   */
  fromSessionMessages = (
    messages: readonly SessionMessage.Info[],
  ): readonly Item[] =>
    pipe(
      messages,
      Arr.flatMap((message: SessionMessage.Info) =>
        Match.value(message).pipe(
          Match.discriminators("type")({
            assistant: fromAssistant,
            compaction: fromCompaction,
            shell: ({ command }) => [
              ConversationItem.ShellCommand({ command }),
            ],
            user: ({ id, text }) => [
              ConversationItem.UserMessage({ id, text }),
            ],
          }),
          Match.orElse(() => []),
        ),
      ),
    )

/** Reads host session messages as the reviewer's conversation. */
export default Object.freeze({ fromSessionMessages })
