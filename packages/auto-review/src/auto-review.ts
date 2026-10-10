import { Context, Duration, Effect, Layer } from "effect"
import DenialBreaker from "./denial-breaker.ts"
import Host from "./host.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import ReviewTimedOut from "./review-timed-out-error.ts"
import Reviewer from "./reviewer.ts"
import Settings from "./settings.ts"
import Verdict from "./verdict.ts"
import reviewDecision from "./review-decision.ts"
import reviewFailure from "./review-failure.ts"

type Settled = Parameters<typeof Verdict.$match>[typeof FIRST]

interface Interface {
  /**
   * Reviews a permission request that would otherwise ask the user, and
   * rewrites its effect and message with the verdict.
   */
  readonly evaluate: (evaluation: PermissionEvaluation) => Effect.Effect<void>
}

const FIRST = 0,
  /* Rewrites the request's effect and message with the verdict. */
  apply = (
    evaluation: PermissionEvaluation,
    verdict: Settled,
  ): Effect.Effect<void> =>
    Effect.sync(() => {
      Verdict.$match(verdict, {
        Allow: () => {
          evaluation.effect = "allow"
        },
        Ask: ({ message }) => {
          evaluation.effect = "ask"
          evaluation.message = message
        },
        Deny: ({ message }) => {
          evaluation.effect = "deny"
          evaluation.message = message
        },
      })
    })

/** Reviews permission prompts before they reach the user. */
class AutoReview extends Context.Service<AutoReview, Interface>()(
  "opencode-auto-review/auto-review/AutoReview",
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
                  new ReviewTimedOut({ timeout: Duration.format(deadline) }),
                ),
            }),
            Effect.matchEffect({
              onFailure: (
                failure: Parameters<
                  typeof reviewFailure.undecided
                >[typeof FIRST],
              ) => {
                const fallback = reviewFailure.undecided(failure)

                return Effect.logWarning(
                  "Auto-review failed; asking the user.",
                  fallback,
                ).pipe(Effect.as(fallback))
              },
              onSuccess: Effect.succeed,
            }),
          )

          yield* Effect.logInfo("Auto-review verdict", {
            action: evaluation.action,
            verdict,
          })

          yield* apply(evaluation, verdict)
        }),
      })
    }),
  )
}

export default AutoReview
