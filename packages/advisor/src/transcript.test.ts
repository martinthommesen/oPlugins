import { ConversationItem, fromSessionMessages } from "./conversation.ts"
import { Effect, Schema } from "effect"
import { assert, describe, expect, it } from "@effect/vitest"
import { renderTranscript, truncate } from "./transcript.ts"
import { SessionMessage } from "@opencode/schema/session-message"

const AMPLE_BUDGET = 10_000

const TIGHT_BUDGET = 300

const FILLER_CHARS = 400

const SMALL_BUDGET = 1000

const LARGE_TEXT_CHARS = 20_000

const MANY_ENTRIES = 100

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
          "[4] assistant: The newest step.",
        ].join("\n"),
      )
    },
  )
})

describe("transcript character limits", () => {
  it(
    "bounds an oversized task and keeps the latest step",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const longTask = ConversationItem.UserMessage({
        text: "task ".repeat(LARGE_TEXT_CHARS),
      })

      const transcript = renderTranscript([longTask, latest], SMALL_BUDGET)

      expect(transcript.length).toBeLessThanOrEqual(SMALL_BUDGET)
      expect(transcript).toContain("user: task")
      expect(transcript).toContain("The newest step.")
    },
  )

  it("counts entry headers and omission markers", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const entries = Array.from({ length: MANY_ENTRIES }, () => latest)

    expect(renderTranscript(entries, SMALL_BUDGET).length).toBeLessThanOrEqual(
      SMALL_BUDGET,
    )
  })

  it(
    "keeps a shortened latest entry if it exceeds the budget",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const longLatest = ConversationItem.AssistantText({
        text: "latest ".repeat(LARGE_TEXT_CHARS),
      })

      const transcript = renderTranscript([task, longLatest], SMALL_BUDGET)

      expect(transcript.length).toBeLessThanOrEqual(SMALL_BUDGET)
      expect(transcript).toContain("assistant: latest")
    },
  )
})

describe(truncate, () => {
  it("includes the marker in its character limit", { timeout: 5000 }, () => {
    expect.hasAssertions()

    expect(
      truncate(SMALL_BUDGET, "x".repeat(LARGE_TEXT_CHARS)).length,
    ).toBeLessThanOrEqual(SMALL_BUDGET)
  })
})
