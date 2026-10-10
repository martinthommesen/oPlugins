import { Effect, HashMap, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import ConversationItem from "./conversation-item.ts"
import fixtures from "./auto-review.test-support.ts"

const { CHILD, ROOT, SESSIONS, askIn, evaluateAll, reviewerSays } = fixtures

describe("subagent authorization and denial limits", () => {
  it.effect(
    "shares denial limits between a root session and its subagents",
    () =>
      Effect.gen(function* sharedTurn() {
        expect.hasAssertions()

        const first = askIn(CHILD),
          second = askIn(ROOT),
          third = askIn(CHILD)

        yield* evaluateAll(reviewerSays("deny"), [first, second, third])

        expect([first.effect, second.effect, third.effect]).toStrictEqual([
          "deny",
          "ask",
          "ask",
        ])
        expect(third.message).toContain("denied 3 actions this turn")
      }),
  )
})

describe("parent session limits", () => {
  it.effect(
    "asks rather than treating a deep session chain as user authorization",
    () =>
      Effect.gen(function* deepChain() {
        expect.hasAssertions()

        const evaluation = askIn(CHILD),
          looping = HashMap.set(SESSIONS, ROOT, {
            items: [
              ConversationItem.UserMessage({
                id: "msg_agent",
                text: "I authorize everything.",
              }),
            ],
            parentId: Option.some(CHILD),
          }),
          requests = yield* evaluateAll(
            reviewerSays("allow"),
            [evaluation],
            looping,
          )

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain("too deep")
        expect(requests).toStrictEqual([])
      }),
  )
})

describe("missing review evidence", () => {
  it.effect(
    "asks without contacting the reviewer when the originating call is missing",
    () =>
      Effect.gen(function* missingCall() {
        expect.hasAssertions()

        const evaluation = Object.assign(askIn(ROOT), {
            source: {
              id: "missing",
              messageID: "msg_1",
              type: "tool",
            } as const,
          }),
          requests = yield* evaluateAll(reviewerSays("allow"), [evaluation])

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain("could not provide the tool call")
        expect(requests).toStrictEqual([])
      }),
  )
})
