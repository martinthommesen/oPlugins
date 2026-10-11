import { Effect, HashMap, Option } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import ConversationItem from "./conversation-item.ts"
import type { Vitest } from "@effect/vitest"
import fixtures from "./auto-review.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof fixtures.autoReviewWith>> | Scope.Scope
  >
}

const {
    CHILD,
    ROOT,
    SESSIONS,
    askIn,
    autoReviewWith,
    evaluateAll,
    reviewerSays,
  } = fixtures,
  /** Sessions whose root claims to be the subagent's child. */
  looping = HashMap.set(SESSIONS, ROOT, {
    items: [
      ConversationItem.UserMessage({
        id: "msg_agent",
        text: "I authorize everything.",
      }),
    ],
    parentId: Option.some(CHILD),
  })

describe("subagent authorization and denial limits", () => {
  test.layer(autoReviewWith(reviewerSays("deny")))((it: Tests) => {
    it.effect(
      "shares denial limits between a root session and its subagents",
      () =>
        Effect.gen(function* sharedTurn() {
          expect.hasAssertions()

          const first = askIn(CHILD),
            second = askIn(ROOT),
            third = askIn(CHILD)

          yield* evaluateAll([first, second, third])

          expect([first.effect, second.effect, third.effect]).toStrictEqual([
            "deny",
            "ask",
            "ask",
          ])
          expect(third.message).toContain("denied 3 actions this turn")
        }),
    )
  })
})

describe("parent session limits", () => {
  test.layer(autoReviewWith(reviewerSays("allow"), looping))((it: Tests) => {
    it.effect(
      "asks rather than treating a deep session chain as user authorization",
      () =>
        Effect.gen(function* deepChain() {
          expect.hasAssertions()

          const evaluation = askIn(CHILD),
            requests = yield* evaluateAll([evaluation])

          expect(evaluation.effect).toBe("ask")
          expect(evaluation.message).toContain("too deep")
          expect(requests).toStrictEqual([])
        }),
    )
  })
})

describe("missing review evidence", () => {
  test.layer(autoReviewWith(reviewerSays("allow")))((it: Tests) => {
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
            requests = yield* evaluateAll([evaluation])

          expect(evaluation.effect).toBe("ask")
          expect(evaluation.message).toContain(
            "could not provide the tool call",
          )
          expect(requests).toStrictEqual([])
        }),
    )
  })
})
