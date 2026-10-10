import { Array as Arr, Effect, Fiber, Layer, Ref } from "effect"
import type { Completion, CompletionError } from "./codex-client.ts"
import { describe, expect, it } from "@effect/vitest"
import { CodexResponses } from "./codex-client.ts"
import type { Config } from "effect"
import { MalformedAssessment } from "./assessment.ts"
import { ModelUnavailable } from "./errors/model-unavailable.ts"
import { RequestFailed } from "./errors/request-failed.ts"
import { ReviewTimedOut } from "./errors/review-timed-out.ts"
import { Reviewer } from "./reviewer.ts"
import { TestClock } from "effect/testing"
import { settingsFrom } from "./testing.ts"

type Script = (model: string) => Effect.Effect<string, CompletionError>

const ALLOW = '{"outcome":"allow"}'

const HTTP_BAD_REQUEST = 400

const TWO_REVIEWS = 2

const invalidRequest: Script = (model) =>
  Effect.fail(
    new RequestFailed({
      cause: "Invalid context length.",
      model,
      operation: "status",
    }),
  )

const request = {
  cacheKey: "ses_1",
  plannedAction: '{"action":"bash"}',
  transcript: "[1] user: Run the tests.",
}

const rejectPrimary: Script = (model) => {
  if (model === "codex-auto-review") {
    return Effect.fail(
      new ModelUnavailable({
        detail: "unsupported",
        model,
        status: HTTP_BAD_REQUEST,
      }),
    )
  }

  return Effect.succeed(ALLOW)
}

const reviewerWith = (
  script: Script,
  models: Ref.Ref<readonly string[]>,
): Layer.Layer<Reviewer, Config.ConfigError> => {
  const complete = (
    completion: Completion,
  ): Effect.Effect<string, CompletionError> =>
    Ref.update(models, Arr.append(completion.model)).pipe(
      Effect.flatMap(() => script(completion.model)),
    )

  const codex = Layer.succeed(CodexResponses, CodexResponses.of({ complete }))

  return Reviewer.layer.pipe(Layer.provide([codex, settingsFrom({})]))
}

const review = Effect.gen(function* review() {
  const reviewer = yield* Reviewer

  return yield* reviewer.review(request)
})

describe("reviewer models", () => {
  it.effect("asks the primary model first", () =>
    Effect.gen(function* primary() {
      const models = yield* Ref.make<readonly string[]>([])

      const result = yield* Effect.provide(
        review,
        reviewerWith(() => Effect.succeed(ALLOW), models),
      )

      expect(result.model).toBe("codex-auto-review")
      expect(result.assessment.outcome).toBe("allow")
    }),
  )

  it.effect("falls back once and then keeps using the fallback", () =>
    Effect.gen(function* fallback() {
      const models = yield* Ref.make<readonly string[]>([])

      const results = yield* Effect.provide(
        Effect.all([review, review]),
        reviewerWith(rejectPrimary, models),
      )

      expect(results.map((result) => result.model)).toStrictEqual([
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
        const models = yield* Ref.make<readonly string[]>([])

        const failures = yield* Effect.provide(
          Effect.all([Effect.flip(review), Effect.flip(review)]),
          reviewerWith(invalidRequest, models),
        )

        expect(failures).toHaveLength(TWO_REVIEWS)
        expect(yield* Ref.get(models)).toStrictEqual([
          "codex-auto-review",
          "codex-auto-review",
        ])
      }),
  )

  it.effect("fails when the answer is not an assessment", () =>
    Effect.gen(function* malformed() {
      const models = yield* Ref.make<readonly string[]>([])

      const failure = yield* Effect.provide(
        review,
        reviewerWith(() => Effect.succeed("I think it is fine."), models),
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(MalformedAssessment)
    }),
  )

  it.effect("fails when the review outlasts the deadline", () =>
    Effect.gen(function* deadline() {
      const models = yield* Ref.make<readonly string[]>([])

      const fiber = yield* Effect.provide(
        review,
        reviewerWith(() => Effect.never, models),
      ).pipe(Effect.flip, Effect.forkChild)

      yield* TestClock.adjust("90 seconds")

      expect(yield* Fiber.join(fiber)).toBeInstanceOf(ReviewTimedOut)
    }),
  )
})
