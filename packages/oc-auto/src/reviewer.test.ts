import { Effect, Fiber, Layer, Ref } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import FakeCodex from "./fake-codex.test-support.ts"
import MalformedAssessment from "./malformed-assessment-error.ts"
import ModelUnavailable from "./model-unavailable-error.ts"
import RequestFailed from "./request-failed-error.ts"
import ReviewTimedOut from "./review-timed-out-error.ts"
import Reviewer from "./reviewer.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import support from "./testing.test-support.ts"

type Script = Parameters<typeof FakeCodex.layer>[typeof FIRST]

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<FakeCodex | Reviewer | Scope.Scope>
}

const ALLOW = '{"outcome":"allow"}',
  FIRST = 0,
  HTTP_BAD_REQUEST = 400,
  REQUEST = {
    cacheKey: "ses_1",
    plannedAction: '{"action":"bash"}',
    transcript: "[1] user: Run the tests.",
  },
  TWO_REVIEWS = 2,
  invalidRequest: Script = (model) =>
    Effect.fail(
      RequestFailed.make({
        cause: "Invalid context length.",
        model,
        operation: "status",
      }),
    ),
  rejectPrimary: Script = (model) => {
    if (model === "codex-auto-review") {
      return Effect.fail(
        ModelUnavailable.make({
          detail: "unsupported",
          model,
          status: HTTP_BAD_REQUEST,
        }),
      )
    }

    return Effect.succeed(ALLOW)
  },
  /** One review of `REQUEST` by the block's reviewer, to run. */
  reviewOf = Reviewer.pipe(Effect.map((reviewer) => reviewer.review(REQUEST))),
  /*
   * A reviewer of its own, whose backend records each model it is asked for
   * and answers with `script`.
   */
  reviewerOver = (
    script: Script,
  ): Layer.Layer<
    FakeCodex | Reviewer,
    Layer.Error<ReturnType<typeof support.settingsFrom>>
  > =>
    Reviewer.layer.pipe(
      Layer.provide(support.settingsFrom({})),
      Layer.provideMerge(FakeCodex.layer(script)),
    ),
  /* A backend that never answers. */
  stalling: Script = () => Effect.never,
  /* A backend that answers without an assessment. */
  vague: Script = () => Effect.succeed("I think it is fine.")

describe("reviewer models", () => {
  test.layer(reviewerOver(() => Effect.succeed(ALLOW)))((it: Tests) => {
    it.effect("asks the primary model first", () =>
      Effect.gen(function* primary() {
        expect.hasAssertions()

        const review = yield* reviewOf,
          reviewed = yield* review

        expect(reviewed.model).toBe("codex-auto-review")
        expect(reviewed.assessment.outcome).toBe("allow")
      }),
    )
  })
  test.layer(reviewerOver(rejectPrimary))((it: Tests) => {
    it.effect("falls back once and then keeps using the fallback", () =>
      Effect.gen(function* fallback() {
        expect.hasAssertions()

        const { models } = yield* FakeCodex,
          review = yield* reviewOf,
          reviews = yield* Effect.all([review, review])

        expect(reviews.map((result) => result.model)).toStrictEqual([
          "gpt-5.5",
          "gpt-5.5",
        ])
        expect(yield* Ref.get(models)).toStrictEqual([
          "codex-auto-review",
          "gpt-5.5",
          "gpt-5.5",
        ])
      }),
    )
  })
})

describe("reviewer failures", () => {
  test.layer(reviewerOver(invalidRequest))((it: Tests) => {
    it.effect(
      "does not remember a fallback for an ordinary request failure",
      () =>
        Effect.gen(function* ordinaryFailure() {
          expect.hasAssertions()

          const { models } = yield* FakeCodex,
            review = yield* reviewOf,
            reviewFailures = yield* Effect.all([
              Effect.flip(review),
              Effect.flip(review),
            ])

          expect(reviewFailures).toHaveLength(TWO_REVIEWS)
          expect(yield* Ref.get(models)).toStrictEqual([
            "codex-auto-review",
            "codex-auto-review",
          ])
        }),
    )
  })
  test.layer(reviewerOver(vague))((it: Tests) => {
    it.effect("fails when the answer is not an assessment", () =>
      Effect.gen(function* malformed() {
        expect.hasAssertions()

        const review = yield* reviewOf

        expect(yield* Effect.flip(review)).toBeInstanceOf(MalformedAssessment)
      }),
    )
  })
  test.layer(reviewerOver(stalling))((it: Tests) => {
    it.effect("fails when the review outlasts the deadline", () =>
      Effect.gen(function* deadline() {
        expect.hasAssertions()

        const review = yield* reviewOf,
          waiting = yield* review.pipe(Effect.flip, Effect.forkChild)

        yield* TestClock.adjust("90 seconds")

        expect(yield* Fiber.join(waiting)).toBeInstanceOf(ReviewTimedOut)
      }),
    )
  })
})
