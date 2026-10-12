import { Array as Arr, Effect, HashMap } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import MalformedAssessment from "./malformed-assessment-error.ts"
import type { Vitest } from "@effect/vitest"
import fixtures from "./auto-review.test-support.ts"

type Script = Parameters<typeof fixtures.autoReviewWith>[typeof FIRST]

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof fixtures.autoReviewWith>> | Scope.Scope
  >
}

const {
    ROOT,
    CHILD,
    askIn,
    autoReviewWith,
    evaluateAll,
    reviewerSays,
    unavailable,
  } = fixtures,
  FIRST = 0,
  /* A reviewer whose answer holds no assessment. */
  malformed: Script = () =>
    Effect.fail(MalformedAssessment.make({ text: "I think it is fine." }))

describe("auto-review verdicts", () => {
  test.layer(autoReviewWith(reviewerSays("allow")))((it: Tests) => {
    it.effect("allows what the reviewer allows", () =>
      Effect.gen(function* allows() {
        expect.hasAssertions()

        const evaluation = askIn(ROOT)

        yield* evaluateAll([evaluation])

        expect(evaluation.effect).toBe("allow")
      }),
    )
  })

  test.layer(autoReviewWith(reviewerSays("deny")))((it: Tests) => {
    it.effect("denies with the reviewer's reason and recovery advice", () =>
      Effect.gen(function* denies() {
        expect.hasAssertions()

        const evaluation = askIn(ROOT)

        yield* evaluateAll([evaluation])

        expect(evaluation.effect).toBe("deny")
        expect(evaluation.message).toContain("Pushes to the default branch.")
        expect(evaluation.message).toContain("materially safer alternative")
      }),
    )
  })
})

describe("auto-review leaves other effects alone", () => {
  test.layer(autoReviewWith(reviewerSays("deny")))((it: Tests) => {
    it.effect("leaves requests that would not ask the user alone", () =>
      Effect.gen(function* untouched() {
        expect.hasAssertions()

        const evaluation = Object.assign(askIn(ROOT), {
            effect: "allow",
          } as const),
          requests = yield* evaluateAll([evaluation])

        expect(evaluation.effect).toBe("allow")
        expect(requests).toStrictEqual([])
      }),
    )
  })

  test.layer(autoReviewWith(reviewerSays("allow")))((it: Tests) => {
    it.effect("does not override configured denials", () =>
      Effect.gen(function* configuredDeny() {
        expect.hasAssertions()

        const evaluation = Object.assign(askIn(ROOT), {
            effect: "deny",
          } as const),
          requests = yield* evaluateAll([evaluation])

        expect(evaluation.effect).toBe("deny")
        expect(requests).toStrictEqual([])
      }),
    )
  })
})

describe("auto-review fallbacks", () => {
  test.layer(autoReviewWith(unavailable))((it: Tests) => {
    it.effect("asks the user when the review fails", () =>
      Effect.gen(function* failed() {
        expect.hasAssertions()

        const evaluation = askIn(ROOT)

        yield* evaluateAll([evaluation])

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain("OpenAI is not connected.")
      }),
    )
  })

  test.layer(autoReviewWith(reviewerSays("deny")))((it: Tests) => {
    it.effect("hands repeated denials in a turn to the user", () =>
      Effect.gen(function* escalates() {
        expect.hasAssertions()

        const first = askIn(ROOT),
          second = askIn(ROOT)

        yield* evaluateAll([first, second])

        expect([first.effect, second.effect]).toStrictEqual(["deny", "ask"])
        expect(second.message).toContain("asking you instead")
      }),
    )
  })

  test.layer(autoReviewWith(reviewerSays("allow")))((it: Tests) => {
    it.effect("shows a subagent's reviewer the user's root conversation", () =>
      Effect.gen(function* subagent() {
        expect.hasAssertions()

        const received = yield* evaluateAll([askIn(CHILD)]),
          request = yield* Effect.fromOption(Arr.head(received))

        expect(request.transcript).toContain(
          '{"label":"user","text":"Ship it."}',
        )
        expect(request.transcript).toContain(
          '{"label":"delegating agent","text":"Push."}',
        )
      }),
    )
  })
})

describe("auto-review failure notes", () => {
  test.layer(autoReviewWith(malformed))((it: Tests) => {
    it.effect("tells the user when the reviewer's answer is unreadable", () =>
      Effect.gen(function* unreadable() {
        expect.hasAssertions()

        const evaluation = askIn(ROOT)

        yield* evaluateAll([evaluation])

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain(
          "The reviewer's answer was not a valid assessment.",
        )
      }),
    )
  })

  test.layer(autoReviewWith(reviewerSays("allow"), HashMap.empty()))(
    (it: Tests) => {
      it.effect("names the host call that failed", () =>
        Effect.gen(function* hostFailure() {
          expect.hasAssertions()

          const evaluation = askIn(ROOT)

          yield* evaluateAll([evaluation])

          expect(evaluation.effect).toBe("ask")
          expect(evaluation.message).toContain(
            "OpenCode failed to answer the plugin's session.get call.",
          )
        }),
      )
    },
  )
})
