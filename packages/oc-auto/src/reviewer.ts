import { Context, Duration, Effect, Layer, Ref } from "effect"
import CodexResponses from "./codex-client.ts"
import PluginOptions from "./plugin-options.ts"
import ReviewTimedOut from "./review-timed-out-error.ts"
import assessment from "./assessment.ts"
import prompt from "./prompt.ts"

interface ReviewRequest {
  /** Groups one session's reviews for the backend's prompt cache. */
  readonly cacheKey: string
  /** The action awaiting approval, as JSON. */
  readonly plannedAction: string
  /** The rendered conversation that led to the request. */
  readonly transcript: string
}

interface Review {
  /** The reviewer's assessment of the planned action. */
  readonly assessment: typeof assessment.Assessment.Type
  /** The model that produced the assessment. */
  readonly model: string
}

type AssessError =
  | Effect.Error<ReturnType<CodexResponses["Service"]["complete"]>>
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
  readonly options: PluginOptions["Service"]
  /** Avoids retrying a rejected primary model until the plugin reloads. */
  readonly primaryUnavailable: Ref.Ref<boolean>
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
   * Reviews with the primary model within the review deadline. Once the
   * backend rejects that model, this and every later review use the
   * fallback model.
   */
  reviewWith = (dependencies: Dependencies): Interface["review"] => {
    const { options, primaryUnavailable } = dependencies,
      assess = assessWith(dependencies),
      fallBack = Effect.fn("Reviewer.fallBack")(function* fallBack(
        request: ReviewRequest,
      ) {
        yield* Ref.set(primaryUnavailable, true)

        yield* Effect.logWarning("reviewer_model_unavailable").pipe(
          Effect.annotateLogs({
            fallbackModel: options.fallbackModel,
            model: options.model,
          }),
        )

        return yield* assess(options.fallbackModel, request)
      }),
      firstChoice = Effect.fn("Reviewer.firstChoice")(function* firstChoice(
        request: ReviewRequest,
      ) {
        if (options.fallbackModel === options.model) {
          return yield* assess(options.model, request)
        }

        if (yield* Ref.get(primaryUnavailable)) {
          return yield* assess(options.fallbackModel, request)
        }

        return yield* assess(options.model, request).pipe(
          Effect.catchTag("ModelUnavailable", () => fallBack(request)),
        )
      })

    return Effect.fn("Reviewer.review")(function* review(
      request: ReviewRequest,
    ) {
      return yield* firstChoice(request).pipe(
        Effect.timeoutOrElse({
          duration: options.timeout,
          orElse: () =>
            Effect.fail(
              ReviewTimedOut.make({
                timeout: Duration.format(options.timeout),
              }),
            ),
        }),
      )
    })
  }

/** Sends permission requests to the reviewer model and parses its assessment. */
class Reviewer extends Context.Service<Reviewer, Interface>()(
  "@martinthommesen/oc-auto/reviewer",
) {
  public static readonly layer = Layer.effect(
    Reviewer,
    Effect.gen(function* makeReviewer() {
      const codex = yield* CodexResponses,
        options = yield* PluginOptions,
        primaryUnavailable = yield* Ref.make(false)

      return Reviewer.of({
        review: reviewWith({
          codex,
          instructions: prompt.reviewerInstructions(options.extraPolicy),
          options,
          primaryUnavailable,
        }),
      })
    }),
  )
}

export default Reviewer
