import { ConversationItem, fromSessionMessages } from "./conversation.ts"
import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { SessionMessage } from "@opencode/schema/session-message"

const decodeMessages = Schema.decodeUnknownEffect(
  Schema.Array(SessionMessage.Info),
)

const CREATED = { created: 0 }

const userMessage = {
  id: "msg_1",
  text: "Run the tests.",
  time: CREATED,
  type: "user",
}

const assistantMessage = {
  agent: "build",
  content: [
    { text: "Thinking it over.", type: "reasoning" },
    { text: "Running them now.", type: "text" },
    {
      id: "call_1",
      name: "bash",
      state: {
        content: [{ text: "ok", type: "text" }],
        input: { command: "pnpm test" },
        status: "completed",
      },
      time: CREATED,
      type: "tool",
    },
  ],
  id: "msg_2",
  model: { id: "gpt-5.5", providerID: "openai" },
  time: CREATED,
  type: "assistant",
}

const systemMessage = {
  id: "msg_3",
  text: "Mode changed.",
  time: CREATED,
  type: "system",
}

describe(fromSessionMessages, () => {
  it.effect("keeps user text, assistant text, and tool calls", () =>
    Effect.gen(function* conversation() {
      const messages = yield* decodeMessages([
        userMessage,
        assistantMessage,
        systemMessage,
      ])

      expect(fromSessionMessages(messages)).toStrictEqual([
        ConversationItem.UserMessage({ id: "msg_1", text: "Run the tests." }),
        ConversationItem.AssistantText({ text: "Running them now." }),
        ConversationItem.ToolCall({
          id: "call_1",
          input: '{"command":"pnpm test"}',
          name: "bash",
        }),
      ])
    }),
  )
})
