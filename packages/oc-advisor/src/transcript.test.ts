import { Effect, Schema } from "effect"
import { assert, describe, expect, it } from "@effect/vitest"
import { SessionMessage } from "@opencode/schema/session-message"
import conversation from "./conversation.ts"
import transcript from "./transcript.ts"

const { ConversationItem } = conversation,
  AMPLE_BUDGET = 10_000,
  CREATED = { created: 0 },
  FILLER_CHARS = 400,
  LARGE_TEXT_CHARS = 20_000,
  MANY_ENTRIES = 100,
  RECORDED = [
    {
      id: "msg_1",
      text: "Fix the failing login test.",
      time: CREATED,
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
          time: CREATED,
          type: "tool",
        },
        {
          id: "call_2",
          name: "advisor",
          state: {
            input: { question: "Why?" },
            metadata: {},
            status: "running",
          },
          time: CREATED,
          type: "tool",
        },
      ],
      id: "msg_2",
      model: { id: "claude-haiku-5-5", providerID: "anthropic" },
      time: CREATED,
      type: "assistant",
    },
  ],
  SMALL_BUDGET = 1000,
  TIGHT_BUDGET = 300,
  dropsPendingConsultation = Effect.gen(function* dropsPending() {
    const messages = yield* Schema.decodeUnknownEffect(
      Schema.Array(SessionMessage.Info),
    )(RECORDED)

    assert.deepStrictEqual(conversation.fromSessionMessages(messages), [
      ConversationItem.UserMessage({
        text: "Fix the failing login test.",
      }),
      ConversationItem.AssistantText({
        text: "Running the tests.",
      }),
      ConversationItem.ToolCall({
        input: '{"command":"pnpm test"}',
        name: "shell",
        result: "1 failed",
      }),
    ])
  }),
  filler = ConversationItem.AssistantText({
    text: "x".repeat(FILLER_CHARS),
  }),
  latest = ConversationItem.AssistantText({
    text: "The newest step.",
  }),
  task = ConversationItem.UserMessage({
    text: "The original task.",
  })

describe("fromSessionMessages", () => {
  it.effect(
    "keeps tool results and drops the pending consultation",
    () => dropsPendingConsultation,
  )
})

describe("renderTranscript", () => {
  it("numbers entries oldest first", { timeout: 5000 }, () => {
    expect.hasAssertions()

    expect(transcript.renderTranscript([task, latest], AMPLE_BUDGET)).toBe(
      "[1] user: The original task.\n\n[2] assistant: The newest step.",
    )
  })

  it(
    "keeps the task and the newest entries when over budget",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      expect(
        transcript.renderTranscript(
          [task, filler, filler, latest],
          TIGHT_BUDGET,
        ),
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
        }),
        rendered = transcript.renderTranscript([longTask, latest], SMALL_BUDGET)

      expect(rendered.length).toBeLessThanOrEqual(SMALL_BUDGET)
      expect(rendered).toContain("user: task")
      expect(rendered).toContain("The newest step.")
    },
  )

  it("counts entry headers and omission markers", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const entries = Array.from({ length: MANY_ENTRIES }, () => latest)

    expect(
      transcript.renderTranscript(entries, SMALL_BUDGET).length,
    ).toBeLessThanOrEqual(SMALL_BUDGET)
  })

  it(
    "keeps a shortened latest entry if it exceeds the budget",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const longLatest = ConversationItem.AssistantText({
          text: "latest ".repeat(LARGE_TEXT_CHARS),
        }),
        rendered = transcript.renderTranscript([task, longLatest], SMALL_BUDGET)

      expect(rendered.length).toBeLessThanOrEqual(SMALL_BUDGET)
      expect(rendered).toContain("assistant: latest")
    },
  )
})

describe("truncate", () => {
  it("includes the marker in its character limit", { timeout: 5000 }, () => {
    expect.hasAssertions()

    expect(
      transcript.truncate(SMALL_BUDGET, "x".repeat(LARGE_TEXT_CHARS)).length,
    ).toBeLessThanOrEqual(SMALL_BUDGET)
  })
})
