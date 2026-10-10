import type { Assessment, MalformedAssessment } from "./assessment.ts"
import { Context, Duration, Effect, Layer, Ref } from "effect"
import { reviewRequest, reviewerInstructions } from "./prompt.ts"
import type { AuthUnavailable } from "./errors/auth-unavailable.ts"
import { CodexResponses } from "./codex-client.ts"
import type { HostError } from "./errors/host-error.ts"
import type { ModelUnavailable } from "./errors/model-unavailable.ts"
import type { RequestFailed } from "./errors/request-failed.ts"
import { ReviewTimedOut } from "./errors/review-timed-out.ts"
import { Settings } from "./settings.ts"
import type { SettingsInterface } from "./settings.ts"
import { parseAssessment } from "./assessment.ts"

interface ReviewRequest {
  /** Groups one session's reviews for the backend's prompt cache. */
  readonly cacheKey: string
  /** The action awaiting approval, as JSON. */
  readonly plannedAction: string
  /** The rendered conversation that led to the request. */
  readonly transcript: string
}

interface Review {
  readonly assessment: Assessment
  /** The model that produced the assessment. */
  readonly model: string
}

type ReviewError =
  | AuthUnavailable
  | HostError
  | MalformedAssessment
  | ModelUnavailable
  | RequestFailed
  | ReviewTimedOut

interface Interface {
  /** Asks the reviewer model for an assessment of one planned action. */
  readonly review: (
    request: ReviewRequest,
  ) => Effect.Effect<Review, ReviewError>
}

interface Dependencies {
  readonly codex: CodexResponses["Service"]
  readonly instructions: string
  /**
   * Set once the account turns the primary model away, so later reviews go
   * straight to the fallback instead of paying for the rejection again.
   */
  readonly primaryUnavailable: Ref.Ref<boolean>
  readonly settings: SettingsInterface
}

/**
 * Builds the single-model assessment step.
 * @param {Dependencies} dependencies The reviewer's services.
 * @returns {Function} Asks one model and parses its verdict.
 */
const assessWith = (
  dependencies: Dependencies,
): ((
  model: string,
  request: ReviewRequest,
) => Effect.Effect<Review, Exclude<ReviewError, ReviewTimedOut>>) =>
  Effect.fn("Reviewer.assess")(function* assess(
    model: string,
    request: ReviewRequest,
  ) {
    const text = yield* dependencies.codex.complete({
      cacheKey: request.cacheKey,
      input: reviewRequest(request.transcript, request.plannedAction),
      instructions: dependencies.instructions,
      model,
    })

    const assessment = yield* parseAssessment(text)

    return { assessment, model }
  })

/**
 * Builds the review operation: primary model, fallback, and deadline.
 * @param {Dependencies} dependencies The reviewer's services.
 * @returns {Interface["review"]} The review operation.
 */
const reviewWith = (dependencies: Dependencies): Interface["review"] => {
  const { primaryUnavailable, settings } = dependencies
  const assess = assessWith(dependencies)

  const fallBack = Effect.fn("Reviewer.fallBack")(function* fallBack(
    request: ReviewRequest,
  ) {
    yield* Ref.set(primaryUnavailable, true)

    yield* Effect.logWarning(
      `Reviewer model ${settings.model} is unavailable; using ${settings.fallbackModel}.`,
    )

    return yield* assess(settings.fallbackModel, request)
  })

  const firstChoice = Effect.fn("Reviewer.firstChoice")(function* firstChoice(
    request: ReviewRequest,
  ) {
    if (settings.fallbackModel === settings.model) {
      return yield* assess(settings.model, request)
    }

    if (yield* Ref.get(primaryUnavailable)) {
      return yield* assess(settings.fallbackModel, request)
    }

    return yield* assess(settings.model, request).pipe(
      Effect.catchTag("ModelUnavailable", () => fallBack(request)),
    )
  })

  return Effect.fn("Reviewer.review")(function* review(request: ReviewRequest) {
    return yield* firstChoice(request).pipe(
      Effect.timeoutOrElse({
        duration: settings.timeout,
        orElse: () =>
          Effect.fail(
            new ReviewTimedOut({ timeout: Duration.format(settings.timeout) }),
          ),
      }),
    )
  })
}

/** Sends permission requests to the reviewer model and parses its verdict. */
class Reviewer extends Context.Service<Reviewer, Interface>()(
  "opencode-auto-review/Reviewer",
) {
  public static readonly layer = Layer.effect(
    Reviewer,
    Effect.gen(function* makeReviewer() {
      const codex = yield* CodexResponses
      const settings = yield* Settings
      const primaryUnavailable = yield* Ref.make(false)

      const review = reviewWith({
        codex,
        instructions: reviewerInstructions(settings.extraPolicy),
        primaryUnavailable,
        settings,
      })

      return Reviewer.of({ review })
    }),
  )
}

export { Reviewer }

export type { Review, ReviewError, ReviewRequest }
