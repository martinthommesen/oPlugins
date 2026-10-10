import { Effect, Option } from "effect"
import {
  currentTurn,
  renderPlannedAction,
  renderTranscript,
  truncate,
} from "./transcript.ts"
import { describe, expect, it } from "@effect/vitest"
import { ConversationItem } from "./conversation.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { sessionId } from "./testing.ts"

const session = [
  ConversationItem.UserMessage({ id: "msg_1", text: "Clean up the build." }),
  ConversationItem.AssistantText({ text: "Removing the output folder." }),
  ConversationItem.ToolCall({
    id: "call_1",
    input: '{"command":"rm -rf dist"}',
    name: "bash",
  }),
]

const SHORT_LIMIT = 5

describe(renderTranscript, () => {
  it.effect("labels the user's messages and the agent's actions", () =>
    Effect.sync(() => {
      expect(renderTranscript(session, Option.none())).toBe(
        [
          "[1] user: Clean up the build.",
          "[2] assistant: Removing the output folder.",
          '[3] assistant tool call bash: {"command":"rm -rf dist"}',
        ].join("\n"),
      )
    }),
  )

  it.effect("treats a subagent's user messages as the delegating agent's", () =>
    Effect.sync(() => {
      const root = [
        ConversationItem.UserMessage({ id: "msg_0", text: "Fix the build." }),
        ConversationItem.AssistantText({ text: "Delegating." }),
      ]

      expect(renderTranscript(session, Option.some(root))).toBe(
        [
          "## Root conversation (the user's own messages)",
          "[1] user: Fix the build.",
          "",
          "## Subagent conversation (its user messages come from the delegating agent)",
          "[1] delegating agent: Clean up the build.",
          "[2] assistant: Removing the output folder.",
          '[3] assistant tool call bash: {"command":"rm -rf dist"}',
        ].join("\n"),
      )
    }),
  )

  it.effect("marks truncated text", () =>
    Effect.sync(() => {
      expect(truncate(SHORT_LIMIT, "abcdefgh")).toBe(
        'abcde<truncated omitted_chars="3" />',
      )
    }),
  )
})

describe(renderPlannedAction, () => {
  it.effect("includes the tool call that raised the request", () =>
    Effect.sync(() => {
      const evaluation: PermissionEvaluation = {
        action: "bash",
        effect: "ask",
        resources: ["rm -rf dist"],
        sessionID: sessionId("ses_1"),
        source: { id: "call_1", messageID: "msg_2", type: "tool" },
      }

      expect(
        JSON.parse(renderPlannedAction(session, evaluation)),
      ).toStrictEqual({
        action: "bash",
        resources: ["rm -rf dist"],
        tool_call: { input: '{"command":"rm -rf dist"}', name: "bash" },
      })
    }),
  )
})

describe(currentTurn, () => {
  it.effect("is the newest user message", () =>
    Effect.sync(() => {
      expect(currentTurn(session)).toStrictEqual(Option.some("msg_1"))
    }),
  )
})
