import { Array as Arr, Context, Effect, Fiber, Layer, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import CodexResponses from "./codex-client.ts"
import MalformedAssessment from "./malformed-assessment-error.ts"
import ModelUnavailable from "./model-unavailable-error.ts"
import RequestFailed from "./request-failed-error.ts"
import ReviewTimedOut from "./review-timed-out-error.ts"
import Reviewer from "./reviewer.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import support from "./testing.test-support.ts"

type Complete = CodexResponses["Service"]["complete"]

type Script = (model: string) => ReturnType<Complete>

const ALLOW = '{"outcome":"allow"}',
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
  /*
   * One review of `REQUEST` with a reviewer of its own, whose backend
   * records each model it is asked for in `models` and answers with
   * `script`.
   */
  reviewOf = (
    script: Script,
    models: Ref.Ref<readonly string[]>,
  ): Effect.Effect<
    ReturnType<Reviewer["Service"]["review"]>,
    Layer.Error<ReturnType<typeof support.settingsFrom>>,
    Scope.Scope
  > => {
    const codex = CodexResponses.of({
        complete: (completion) =>
          Ref.update(models, Arr.append(completion.model)).pipe(
            Effect.flatMap(() => script(completion.model)),
          ),
      }),
      reviewer = Reviewer.layer.pipe(
        Layer.provide([
          Layer.succeed(CodexResponses, codex),
          support.settingsFrom({}),
        ]),
      )

    return Layer.build(reviewer).pipe(
      Effect.map((built) => Context.get(built, Reviewer).review(REQUEST)),
    )
  }

describe("reviewer models", () => {
  it.effect("asks the primary model first", () =>
    Effect.gen(function* primary() {
      expect.hasAssertions()

      const models = yield* Ref.make<readonly string[]>([]),
        review = yield* reviewOf(() => Effect.succeed(ALLOW), models),
        reviewed = yield* review

      expect(reviewed.model).toBe("codex-auto-review")
      expect(reviewed.assessment.outcome).toBe("allow")
    }),
  )

  it.effect("falls back once and then keeps using the fallback", () =>
    Effect.gen(function* fallback() {
      expect.hasAssertions()

      const models = yield* Ref.make<readonly string[]>([]),
        review = yield* reviewOf(rejectPrimary, models),
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

describe("reviewer failures", () => {
  it.effect(
    "does not remember a fallback for an ordinary request failure",
    () =>
      Effect.gen(function* ordinaryFailure() {
        expect.hasAssertions()

        const models = yield* Ref.make<readonly string[]>([]),
          review = yield* reviewOf(invalidRequest, models),
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

  it.effect("fails when the answer is not an assessment", () =>
    Effect.gen(function* malformed() {
      expect.hasAssertions()

      const models = yield* Ref.make<readonly string[]>([]),
        review = yield* reviewOf(
          () => Effect.succeed("I think it is fine."),
          models,
        )

      expect(yield* Effect.flip(review)).toBeInstanceOf(MalformedAssessment)
    }),
  )

  it.effect("fails when the review outlasts the deadline", () =>
    Effect.gen(function* deadline() {
      expect.hasAssertions()

      const models = yield* Ref.make<readonly string[]>([]),
        review = yield* reviewOf(() => Effect.never, models),
        waiting = yield* review.pipe(Effect.flip, Effect.forkChild)

      yield* TestClock.adjust("90 seconds")

      expect(yield* Fiber.join(waiting)).toBeInstanceOf(ReviewTimedOut)
    }),
  )
})
