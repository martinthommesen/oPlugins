import { Context, Duration, Effect, Layer, Ref } from "effect"
import CodexResponses from "./codex-client.ts"
import ReviewTimedOut from "./review-timed-out-error.ts"
import Settings from "./settings.ts"
import assessment from "./assessment.ts"
import prompt from "./prompt.ts"

type Complete = CodexResponses["Service"]["complete"]

interface ReviewRequest {
  /** Groups one session's reviews for the backend's prompt cache. */
  readonly cacheKey: string
  /** The action awaiting approval, as JSON. */
  readonly plannedAction: string
  /** The rendered conversation that led to the request. */
  readonly transcript: string
}

interface Review {
  readonly assessment: typeof assessment.Assessment.Type
  /** The model that produced the assessment. */
  readonly model: string
}

type AssessError =
  | Effect.Error<ReturnType<Complete>>
  | Effect.Error<ReturnType<typeof assessment.parse>>

interface Interface {
  /** Asks the reviewer model for an assessment of one planned action. */
  readonly review: (
    request: ReviewRequest,
  ) => Effect.Effect<Review, AssessError | ReviewTimedOut>
}

interface Dependencies {
  readonly codex: CodexResponses["Service"]
  readonly instructions: string
  /** Avoids retrying a rejected primary model until the plugin reloads. */
  readonly primaryUnavailable: Ref.Ref<boolean>
  readonly settings: Settings["Service"]
}

/* Asks `model` for an assessment of `request`. */
const assessWith = (
    dependencies: Dependencies,
  ): ((
    model: string,
    request: ReviewRequest,
  ) => Effect.Effect<Review, AssessError>) =>
    Effect.fn("Reviewer.assess")(function* assess(
      model: string,
      request: ReviewRequest,
    ) {
      const text = yield* dependencies.codex.complete({
        cacheKey: request.cacheKey,
        input: prompt.reviewRequest(request.transcript, request.plannedAction),
        instructions: dependencies.instructions,
        model,
      })

      return { assessment: yield* assessment.parse(text), model }
    }),
  /*
   * Reviews with the primary model, falling back for good once the backend
   * rejects it, all within the review deadline.
   */
  reviewWith = (dependencies: Dependencies): Interface["review"] => {
    const { primaryUnavailable, settings } = dependencies,
      assess = assessWith(dependencies),
      fallBack = Effect.fn("Reviewer.fallBack")(function* fallBack(
        request: ReviewRequest,
      ) {
        yield* Ref.set(primaryUnavailable, true)

        yield* Effect.logWarning(
          `Reviewer model ${settings.model} is unavailable; using ${settings.fallbackModel}.`,
        )

        return yield* assess(settings.fallbackModel, request)
      }),
      firstChoice = Effect.fn("Reviewer.firstChoice")(function* firstChoice(
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

    return Effect.fn("Reviewer.review")(function* review(
      request: ReviewRequest,
    ) {
      return yield* firstChoice(request).pipe(
        Effect.timeoutOrElse({
          duration: settings.timeout,
          orElse: () =>
            Effect.fail(
              new ReviewTimedOut({
                timeout: Duration.format(settings.timeout),
              }),
            ),
        }),
      )
    })
  }

/** Sends permission requests to the reviewer model and parses its verdict. */
class Reviewer extends Context.Service<Reviewer, Interface>()(
  "@martinthommesen/oc-auto/reviewer",
) {
  public static readonly layer = Layer.effect(
    Reviewer,
    Effect.gen(function* makeReviewer() {
      const codex = yield* CodexResponses,
        primaryUnavailable = yield* Ref.make(false),
        settings = yield* Settings

      return Reviewer.of({
        review: reviewWith({
          codex,
          instructions: prompt.reviewerInstructions(settings.extraPolicy),
          primaryUnavailable,
          settings,
        }),
      })
    }),
  )
}

export default Reviewer
