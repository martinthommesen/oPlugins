import { Array as Arr, Effect } from "effect"
import { describe, expect, it } from "@effect/vitest"
import fixtures from "./auto-review.test-support.ts"

const { ROOT, CHILD, askIn, evaluateAll, reviewerSays, unavailable } = fixtures

describe("auto-review verdicts", () => {
  it.effect("allows what the reviewer allows", () =>
    Effect.gen(function* allows() {
      expect.hasAssertions()

      const evaluation = askIn(ROOT)

      yield* evaluateAll(reviewerSays("allow"), [evaluation])

      expect(evaluation.effect).toBe("allow")
    }),
  )

  it.effect("denies with the reviewer's reason and recovery advice", () =>
    Effect.gen(function* denies() {
      expect.hasAssertions()

      const evaluation = askIn(ROOT)

      yield* evaluateAll(reviewerSays("deny"), [evaluation])

      expect(evaluation.effect).toBe("deny")
      expect(evaluation.message).toContain("Pushes to the default branch.")
      expect(evaluation.message).toContain("materially safer alternative")
    }),
  )
})

describe("auto-review leaves other effects alone", () => {
  it.effect("leaves requests that would not ask the user alone", () =>
    Effect.gen(function* untouched() {
      expect.hasAssertions()

      const evaluation = Object.assign(askIn(ROOT), {
          effect: "allow",
        } as const),
        requests = yield* evaluateAll(reviewerSays("deny"), [evaluation])

      expect(evaluation.effect).toBe("allow")
      expect(requests).toStrictEqual([])
    }),
  )

  it.effect("does not override configured denials", () =>
    Effect.gen(function* configuredDeny() {
      expect.hasAssertions()

      const evaluation = Object.assign(askIn(ROOT), {
          effect: "deny",
        } as const),
        requests = yield* evaluateAll(reviewerSays("allow"), [evaluation])

      expect(evaluation.effect).toBe("deny")
      expect(requests).toStrictEqual([])
    }),
  )
})

describe("auto-review fallbacks", () => {
  it.effect("asks the user when the review fails", () =>
    Effect.gen(function* failed() {
      expect.hasAssertions()

      const evaluation = askIn(ROOT)

      yield* evaluateAll(unavailable, [evaluation])

      expect(evaluation.effect).toBe("ask")
      expect(evaluation.message).toContain("OpenAI is not connected.")
    }),
  )

  it.effect("hands repeated denials in a turn to the user", () =>
    Effect.gen(function* escalates() {
      expect.hasAssertions()

      const first = askIn(ROOT),
        second = askIn(ROOT)

      yield* evaluateAll(reviewerSays("deny"), [first, second])

      expect([first.effect, second.effect]).toStrictEqual(["deny", "ask"])
      expect(second.message).toContain("asking you instead")
    }),
  )

  it.effect("shows a subagent's reviewer the user's root conversation", () =>
    Effect.gen(function* subagent() {
      expect.hasAssertions()

      const received = yield* evaluateAll(reviewerSays("allow"), [
          askIn(CHILD),
        ]),
        request = yield* Effect.fromOption(Arr.head(received))

      expect(request.transcript).toContain('{"label":"user","text":"Ship it."}')
      expect(request.transcript).toContain(
        '{"label":"delegating agent","text":"Push."}',
      )
    }),
  )
})
