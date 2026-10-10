import { ConversationItem, fromSessionMessages } from "./conversation.ts"
import { Effect, Schema } from "effect"
import { assert, describe, expect, it } from "@effect/vitest"
import { SessionMessage } from "@opencode/schema/session-message"
import { renderTranscript } from "./transcript.ts"

const AMPLE_BUDGET = 10_000

const TIGHT_BUDGET = 300

const FILLER_CHARS = 400

const created = { created: 0 }

const recorded = [
  {
    id: "msg_1",
    text: "Fix the failing login test.",
    time: created,
    type: "user",
  },
  {
    agent: "build",
    content: [
      { text: "Running the tests.", type: "text" },
      {
        id: "call_1",
        name: "shell",
        state: {
          content: [{ text: "1 failed", type: "text" }],
          input: { command: "pnpm test" },
          status: "completed",
        },
        time: created,
        type: "tool",
      },
      {
        id: "call_2",
        name: "advisor",
        state: { input: { question: "Why?" }, metadata: {}, status: "running" },
        time: created,
        type: "tool",
      },
    ],
    id: "msg_2",
    model: { id: "claude-haiku-5-5", providerID: "anthropic" },
    time: created,
    type: "assistant",
  },
]

const dropsPendingConsultation = Effect.gen(function* dropsPending() {
  const messages = yield* Schema.decodeUnknownEffect(
    Schema.Array(SessionMessage.Info),
  )(recorded)

  assert.deepStrictEqual(fromSessionMessages(messages), [
    ConversationItem.UserMessage({ text: "Fix the failing login test." }),
    ConversationItem.AssistantText({ text: "Running the tests." }),
    ConversationItem.ToolCall({
      input: '{"command":"pnpm test"}',
      name: "shell",
      result: "1 failed",
    }),
  ])
})

const task = ConversationItem.UserMessage({ text: "The original task." })

const filler = ConversationItem.AssistantText({
  text: "x".repeat(FILLER_CHARS),
})

const latest = ConversationItem.AssistantText({ text: "The newest step." })

describe(fromSessionMessages, () => {
  it.effect(
    "keeps tool results and drops the pending consultation",
    () => dropsPendingConsultation,
  )
})

describe(renderTranscript, () => {
  it("numbers entries oldest first", { timeout: 5000 }, () => {
    expect.hasAssertions()

    expect(renderTranscript([task, latest], AMPLE_BUDGET)).toBe(
      "[1] user: The original task.\n\n[2] assistant: The newest step.",
    )
  })

  it(
    "keeps the task and the newest entries when over budget",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      expect(
        renderTranscript([task, filler, filler, latest], TIGHT_BUDGET),
      ).toBe(
        [
          '<truncated omitted_entries="2" />',
          "",
          "[1] user: The original task.",
          "",
          "[2] assistant: The newest step.",
        ].join("\n"),
      )
    },
  )
})
