import { BreakerDecision, DenialBreaker } from "./denial-breaker.ts"
import { Context, Duration, Effect, Layer, Option } from "effect"
import {
  ContextUnavailable,
  currentTurn,
  renderPlannedAction,
  renderTranscript,
} from "./transcript.ts"
import { ReviewTimedOut, Reviewer } from "./reviewer.ts"
import {
  Verdict,
  denialMessage,
  escalationMessage,
  undecided,
} from "./verdict.ts"
import type { ConversationItem } from "./conversation.ts"
import { Host } from "./host.ts"
import type { HostError } from "./errors/host-error.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { Review } from "./reviewer.ts"
import type { ReviewFailure } from "./verdict.ts"
import type { ReviewTurn } from "./denial-breaker.ts"
import type { SessionId } from "./host.ts"
import { Settings } from "./settings.ts"

interface Interface {
  /**
   * Reviews a permission request that would otherwise ask the user, and
   * rewrites its effect and message with the verdict.
   */
  readonly evaluate: (evaluation: PermissionEvaluation) => Effect.Effect<void>
}

interface Dependencies {
  readonly breaker: DenialBreaker["Service"]
  readonly host: Host["Service"]
  readonly reviewer: Reviewer["Service"]
}

type Decide = (
  evaluation: PermissionEvaluation,
) => Effect.Effect<Verdict, ReviewFailure>

/** Subagents nest; this bounds the walk up to the user's own session. */
const MAX_SESSION_DEPTH = 8

const NEXT_LEVEL = 1

interface RootConversation {
  readonly items: readonly ConversationItem[]
  readonly sessionId: SessionId
}

const apply = (
  evaluation: PermissionEvaluation,
  verdict: Verdict,
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

const rootConversationWith = (
  host: Host["Service"],
): ((
  sessionId: SessionId,
  depth: number,
) => Effect.Effect<RootConversation, HostError | ContextUnavailable>) => {
  const rootConversation = Effect.fn("AutoReview.rootConversation")(
    function* walkRoot(
      sessionId: SessionId,
      depth: number,
    ): Effect.fn.Return<RootConversation, HostError | ContextUnavailable> {
      const snapshot = yield* host.session(sessionId)

      if (Option.isNone(snapshot.parentId)) {
        return { items: snapshot.items, sessionId }
      }

      if (depth >= MAX_SESSION_DEPTH) {
        return yield* new ContextUnavailable({
          reason:
            "OpenCode's session chain is too deep to identify the user's root conversation.",
        })
      }

      return yield* rootConversation(
        snapshot.parentId.value,
        depth + NEXT_LEVEL,
      )
    },
  )

  return rootConversation
}

const settleWith = (
  breaker: DenialBreaker["Service"],
): ((turn: ReviewTurn, review: Review) => Effect.Effect<Verdict>) =>
  Effect.fn("AutoReview.settle")(function* settle(
    turn: ReviewTurn,
    review: Review,
  ) {
    const { assessment } = review

    if (assessment.outcome === "allow") {
      yield* breaker.recordApproval(turn)

      return Verdict.Allow({
        model: review.model,
        rationale: assessment.rationale,
      })
    }

    const decision = yield* breaker.recordDenial(turn)

    return BreakerDecision.$match(decision, {
      Deny: () => Verdict.Deny({ message: denialMessage(assessment) }),
      Escalate: ({ total }) =>
        Verdict.Ask({ message: escalationMessage(assessment, total) }),
    })
  })

const decideWith = (dependencies: Dependencies): Decide => {
  const { host, reviewer } = dependencies
  const rootConversation = rootConversationWith(host)
  const settle = settleWith(dependencies.breaker)

  return Effect.fn("AutoReview.decide")(function* decide(
    evaluation: PermissionEvaluation,
  ) {
    const snapshot = yield* host.session(evaluation.sessionID)

    const root = yield* Option.match(snapshot.parentId, {
      onNone: () =>
        Effect.succeed({
          items: snapshot.items,
          sessionId: evaluation.sessionID,
        }),
      onSome: (parent) => rootConversation(parent, NEXT_LEVEL),
    })

    const userMessageId = yield* Effect.fromOption(
      currentTurn(root.items),
    ).pipe(
      Effect.mapError(
        () =>
          new ContextUnavailable({
            reason:
              "The root conversation contains no user message to identify this turn.",
          }),
      ),
    )

    const plannedAction = yield* renderPlannedAction(snapshot.items, evaluation)

    const transcript = yield* renderTranscript(
      snapshot.items,
      snapshot.parentId.pipe(Option.map(() => root.items)),
    )

    const review = yield* reviewer.review({
      cacheKey: evaluation.sessionID,
      plannedAction,
      transcript,
    })

    return yield* settle({ sessionId: root.sessionId, userMessageId }, review)
  })
}

/** Reviews permission prompts before they reach the user. */
class AutoReview extends Context.Service<AutoReview, Interface>()(
  "opencode-auto-review/AutoReview",
) {
  public static readonly layer = Layer.effect(
    AutoReview,
    Effect.gen(function* makeAutoReview() {
      const settings = yield* Settings

      const decide = decideWith({
        breaker: yield* DenialBreaker,
        host: yield* Host,
        reviewer: yield* Reviewer,
      })

      const evaluate = Effect.fn("AutoReview.evaluate")(function* evaluate(
        evaluation: PermissionEvaluation,
      ) {
        if (evaluation.effect !== "ask") {
          return
        }

        const verdict = yield* decide(evaluation).pipe(
          Effect.timeoutOrElse({
            duration: settings.timeout,
            orElse: () =>
              Effect.fail(
                new ReviewTimedOut({
                  timeout: Duration.format(settings.timeout),
                }),
              ),
          }),
          Effect.matchEffect({
            onFailure: (failure: ReviewFailure) => {
              const fallback = undecided(failure)

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
      })

      return AutoReview.of({ evaluate })
    }),
  )
}

export { AutoReview }
