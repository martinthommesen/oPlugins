import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import ContextUnavailable from "./context-unavailable-error.ts"
import ConversationItem from "./conversation-item.ts"
import fixtures from "./transcript.test-support.ts"
import transcript from "./transcript.ts"

const LARGE_INPUT_CHARS = 7000,
  OVERSIZED_INPUT_CHARS = 9000

describe("renderPlannedAction", () => {
  it.effect("includes the tool call that raised the request", () =>
    Effect.gen(function* plannedAction() {
      expect.hasAssertions()

      const action = yield* transcript.renderPlannedAction(
        fixtures.SESSION,
        fixtures.EVALUATION,
      )

      expect(yield* fixtures.decodeJson(action)).toStrictEqual({
        action: "bash",
        resources: ["rm -rf dist"],
        tool_call: { input: '{"command":"rm -rf dist"}', name: "bash" },
      })
    }),
  )

  it.effect("matches both the tool ID and the originating message ID", () =>
    Effect.gen(function* exactIdentity() {
      expect.hasAssertions()

      const action = yield* transcript.renderPlannedAction(
        [
          ...fixtures.SESSION,
          ConversationItem.ToolCall({
            id: "call_1",
            input: '{"command":"true"}',
            messageId: "msg_other",
            name: "bash",
          }),
        ],
        fixtures.EVALUATION,
      )

      expect(yield* fixtures.decodeJson(action)).toMatchObject({
        tool_call: { input: '{"command":"rm -rf dist"}', name: "bash" },
      })
    }),
  )
})

describe("renderPlannedAction evidence", () => {
  it.effect(
    "fails when the request names a call absent from the conversation",
    () =>
      Effect.gen(function* absentCall() {
        expect.hasAssertions()

        const failure = yield* transcript
          .renderPlannedAction([], fixtures.EVALUATION)
          .pipe(Effect.flip)

        expect(failure).toBeInstanceOf(ContextUnavailable)
      }),
  )
})

describe("planned action size limits", () => {
  it.effect("keeps the dangerous tail of a large input that fits", () =>
    Effect.gen(function* completeInput() {
      expect.hasAssertions()

      const input = yield* fixtures.encodeJson({
          command: `echo ${"x".repeat(LARGE_INPUT_CHARS)}; rm -rf ~`,
        }),
        rendered = yield* transcript.renderPlannedAction(
          [
            ConversationItem.ToolCall({
              id: "call_1",
              input,
              messageId: "msg_2",
              name: "bash",
            }),
          ],
          fixtures.EVALUATION,
        )

      expect(yield* fixtures.decodeJson(rendered)).toMatchObject({
        tool_call: { input },
      })
      expect(rendered).not.toContain("<truncated")
    }),
  )
})

describe("planned action size failures", () => {
  it.effect("fails rather than hiding the tail of an oversized action", () =>
    Effect.gen(function* oversizedAction() {
      expect.hasAssertions()

      const input = yield* fixtures.encodeJson({
          command: `echo ${"x".repeat(OVERSIZED_INPUT_CHARS)}; rm -rf ~`,
        }),
        rejection = yield* transcript
          .renderPlannedAction(
            [
              ConversationItem.ToolCall({
                id: "call_1",
                input,
                messageId: "msg_2",
                name: "bash",
              }),
            ],
            fixtures.EVALUATION,
          )
          .pipe(Effect.flip)

      expect(rejection).toBeInstanceOf(ContextUnavailable)
      expect(rejection.reason).toContain("not truncated")
    }),
  )
})

describe("currentTurn", () => {
  it.effect("is the newest user message", () =>
    Effect.sync(() => {
      expect.hasAssertions()
      expect(transcript.currentTurn(fixtures.SESSION)).toStrictEqual(
        Option.some("msg_1"),
      )
    }),
  )
})
