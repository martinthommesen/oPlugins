import { BreakerDecision, DenialBreaker } from "./denial-breaker.ts"
import { Context, Effect, Layer, Option, pipe } from "effect"
import type { Review, ReviewError } from "./reviewer.ts"
import {
  Verdict,
  denialMessage,
  escalationMessage,
  undecided,
} from "./verdict.ts"
import {
  currentTurn,
  renderPlannedAction,
  renderTranscript,
} from "./transcript.ts"
import type { ConversationItem } from "./conversation.ts"
import { Host } from "./host.ts"
import type { HostError } from "./errors/host-error.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Reviewer } from "./reviewer.ts"
import type { SessionId } from "./host.ts"

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

/** Subagents nest; this bounds the walk up to the user's own session. */
const MAX_SESSION_DEPTH = 8

const NEXT_LEVEL = 1

/** Stands in for the turn id before the session has a user message. */
const SESSION_START = "session-start"

/**
 * Applies a verdict to the host's permission evaluation.
 * @param {PermissionEvaluation} evaluation The event OpenCode passed in.
 * @param {Verdict} verdict The decision.
 * @returns {Effect.Effect<void>} Mutates the event as the hook contract asks.
 */
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

/**
 * Builds the walk from a subagent session up to the user's root session.
 * @param {Host["Service"]} host The host service.
 * @returns {Function} Reads the root session's conversation.
 */
const rootConversationWith = (
  host: Host["Service"],
): ((
  sessionId: SessionId,
  depth: number,
) => Effect.Effect<readonly ConversationItem[], HostError>) => {
  const rootConversation = (
    sessionId: SessionId,
    depth: number,
  ): Effect.Effect<readonly ConversationItem[], HostError> =>
    host.session(sessionId).pipe(
      Effect.flatMap((snapshot) =>
        pipe(
          snapshot.parentId,
          Option.filter(() => depth < MAX_SESSION_DEPTH),
          Option.match({
            onNone: () => Effect.succeed(snapshot.items),
            onSome: (parent) => rootConversation(parent, depth + NEXT_LEVEL),
          }),
        ),
      ),
    )

  return rootConversation
}

/**
 * Builds the step that turns an assessment into a verdict, counting denials.
 * @param {DenialBreaker["Service"]} breaker The denial counter.
 * @returns {Function} Settles one review.
 */
const settleWith = (
  breaker: DenialBreaker["Service"],
): ((
  sessionId: string,
  turn: string,
  review: Review,
) => Effect.Effect<Verdict>) =>
  Effect.fn("AutoReview.settle")(function* settle(
    sessionId: string,
    turn: string,
    review: Review,
  ) {
    const { assessment } = review

    if (assessment.outcome === "allow") {
      yield* breaker.recordApproval(sessionId, turn)

      return Verdict.Allow({
        model: review.model,
        rationale: assessment.rationale,
      })
    }

    const decision = yield* breaker.recordDenial(sessionId, turn)

    return BreakerDecision.$match(decision, {
      Deny: () => Verdict.Deny({ message: denialMessage(assessment) }),
      Escalate: ({ total }) =>
        Verdict.Ask({ message: escalationMessage(assessment, total) }),
    })
  })

/**
 * Builds the review of one permission request.
 * @param {Dependencies} dependencies The services a review uses.
 * @returns {Function} Reviews a request and returns the verdict.
 */
const decideWith = (
  dependencies: Dependencies,
): ((
  evaluation: PermissionEvaluation,
) => Effect.Effect<Verdict, HostError | ReviewError>) => {
  const { host, reviewer } = dependencies
  const rootConversation = rootConversationWith(host)
  const settle = settleWith(dependencies.breaker)

  return Effect.fn("AutoReview.decide")(function* decide(
    evaluation: PermissionEvaluation,
  ) {
    const snapshot = yield* host.session(evaluation.sessionID)

    const root = yield* Option.match(snapshot.parentId, {
      onNone: () => Effect.succeedNone,
      onSome: (parent) => Effect.asSome(rootConversation(parent, NEXT_LEVEL)),
    })

    const review = yield* reviewer.review({
      cacheKey: evaluation.sessionID,
      plannedAction: renderPlannedAction(snapshot.items, evaluation),
      transcript: renderTranscript(snapshot.items, root),
    })

    const turn = Option.getOrElse(
      currentTurn(snapshot.items),
      () => SESSION_START,
    )

    return yield* settle(evaluation.sessionID, turn, review)
  })
}

/** Reviews permission prompts before they reach the user. */
class AutoReview extends Context.Service<AutoReview, Interface>()(
  "opencode-auto-review/AutoReview",
) {
  public static readonly layer = Layer.effect(
    AutoReview,
    Effect.gen(function* makeAutoReview() {
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
          Effect.matchEffect({
            onFailure: (failure) =>
              Effect.logWarning(
                "Auto-review failed; asking the user.",
                failure,
              ).pipe(Effect.as(undecided(failure))),
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
