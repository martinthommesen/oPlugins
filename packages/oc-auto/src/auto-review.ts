import { Context, Duration, Effect, Layer } from "effect"
import DenialBreaker from "./denial-breaker.ts"
import Host from "./host.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import ReviewTimedOut from "./review-timed-out-error.ts"
import Reviewer from "./reviewer.ts"
import Settings from "./settings.ts"
import reviewDecision from "./review-decision.ts"
import reviewFailure from "./review-failure.ts"
import verdictOutcome from "./verdict-outcome.ts"

interface Interface {
  /**
   * Reviews a permission request that would otherwise ask the user, and
   * rewrites its effect and message with the verdict.
   */
  readonly evaluate: (evaluation: PermissionEvaluation) => Effect.Effect<void>
}

/** Reviews permission prompts before they reach the user. */
class AutoReview extends Context.Service<AutoReview, Interface>()(
  "@martinthommesen/oc-auto/auto-review/AutoReview",
) {
  public static readonly layer = Layer.effect(
    AutoReview,
    Effect.gen(function* makeAutoReview() {
      const deadline = (yield* Settings).timeout,
        decide = reviewDecision.verdictWith({
          breaker: yield* DenialBreaker,
          host: yield* Host,
          reviewer: yield* Reviewer,
        })

      return AutoReview.of({
        evaluate: Effect.fn("AutoReview.evaluate")(function* evaluate(
          evaluation: PermissionEvaluation,
        ) {
          if (evaluation.effect !== "ask") {
            return
          }

          const verdict = yield* decide(evaluation).pipe(
            Effect.timeoutOrElse({
              duration: deadline,
              orElse: () =>
                Effect.fail(
                  ReviewTimedOut.make({ timeout: Duration.format(deadline) }),
                ),
            }),
            Effect.matchEffect({
              onFailure: reviewFailure.userDecides,
              onSuccess: Effect.succeed,
            }),
          )

          yield* verdictOutcome.record(evaluation, verdict)
          yield* verdictOutcome.apply(evaluation, verdict)
        }),
      })
    }),
  )
}

export default AutoReview
