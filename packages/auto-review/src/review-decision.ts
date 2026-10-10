import { Effect, Option } from "effect"
import BreakerDecision from "./breaker-decision.ts"
import ContextUnavailable from "./context-unavailable-error.ts"
import type DenialBreaker from "./denial-breaker.ts"
import type Host from "./host.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type Reviewer from "./reviewer.ts"
import Verdict from "./verdict.ts"
import transcript from "./transcript.ts"
import verdictMessages from "./verdict-messages.ts"

type SessionId = PermissionEvaluation["sessionID"]

type Snapshot = Effect.Success<ReturnType<Host["Service"]["session"]>>

type HostFailure = Effect.Error<ReturnType<Host["Service"]["session"]>>

type ReviewTurn = Parameters<
  DenialBreaker["Service"]["recordDenial"]
>[typeof FIRST]

type Review = Effect.Success<ReturnType<Reviewer["Service"]["review"]>>

type Settled = Parameters<typeof Verdict.$match>[typeof FIRST]

/** Why a request could not be decided. */
type Undecided =
  | ContextUnavailable
  | HostFailure
  | Effect.Error<ReturnType<Reviewer["Service"]["review"]>>

interface Dependencies {
  readonly breaker: DenialBreaker["Service"]
  readonly host: Host["Service"]
  readonly reviewer: Reviewer["Service"]
}

interface RootConversation {
  readonly items: Snapshot["items"]
  readonly sessionId: string
}

/** The turn a request belongs to, in the user's root conversation. */
interface RootTurn extends ReviewTurn {
  readonly items: Snapshot["items"]
}

const FIRST = 0,
  /** Subagents nest; this bounds the walk up to the user's own session. */
  MAX_SESSION_DEPTH = 8,
  NEXT_LEVEL = 1,
  /* Finds the user's root conversation above a subagent's session. */
  rootConversationWith = (
    host: Host["Service"],
  ): ((
    sessionId: SessionId,
    depth: number,
  ) => Effect.Effect<RootConversation, HostFailure | ContextUnavailable>) => {
    const rootConversation = Effect.fn("AutoReview.rootConversation")(
      function* walkRoot(
        sessionId: SessionId,
        depth: number,
      ): Effect.fn.Return<RootConversation, HostFailure | ContextUnavailable> {
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
  },
  /* Counts the reviewer's assessment against the turn and settles the request. */
  settleWith = (
    breaker: DenialBreaker["Service"],
  ): ((turn: ReviewTurn, review: Review) => Effect.Effect<Settled>) =>
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

      return yield* breaker.recordDenial(turn).pipe(
        Effect.map(
          BreakerDecision.$match({
            Deny: () =>
              Verdict.Deny({
                message: verdictMessages.denialMessage(assessment),
              }),
            Escalate: ({ total }) =>
              Verdict.Ask({
                message: verdictMessages.escalationMessage(assessment, total),
              }),
          }),
        ),
      )
    }),
  /* The current turn of `root`: its newest user message. */
  turnOf = (
    root: RootConversation,
  ): Effect.Effect<RootTurn, ContextUnavailable> =>
    Effect.fromOption(transcript.currentTurn(root.items)).pipe(
      Effect.mapError(
        () =>
          new ContextUnavailable({
            reason:
              "The root conversation contains no user message to identify this turn.",
          }),
      ),
      Effect.map((userMessageId) => ({
        items: root.items,
        sessionId: root.sessionId,
        userMessageId,
      })),
    ),
  /*
   * Reviews one permission request: finds the turn it belongs to, renders
   * the evidence, asks the reviewer, and counts the outcome.
   */
  verdictWith = (
    dependencies: Dependencies,
  ): ((
    evaluation: PermissionEvaluation,
  ) => Effect.Effect<Settled, Undecided>) => {
    const { host, reviewer } = dependencies,
      rootConversation = rootConversationWith(host),
      settle = settleWith(dependencies.breaker)

    return Effect.fn("AutoReview.decide")(function* decide(
      evaluation: PermissionEvaluation,
    ) {
      const snapshot = yield* host.session(evaluation.sessionID),
        turn = yield* Option.match(snapshot.parentId, {
          onNone: () =>
            Effect.succeed({
              items: snapshot.items,
              sessionId: evaluation.sessionID,
            }),
          onSome: (parent) => rootConversation(parent, NEXT_LEVEL),
        }).pipe(Effect.flatMap(turnOf)),
        /* The root conversation is shown only to a subagent's reviewer. */
        visibleRoot = snapshot.parentId.pipe(Option.map(() => turn.items)),
        [plannedAction, rendered] = yield* Effect.all([
          transcript.renderPlannedAction(snapshot.items, evaluation),
          transcript.renderTranscript(snapshot.items, visibleRoot),
        ])

      return yield* reviewer
        .review({
          cacheKey: evaluation.sessionID,
          plannedAction,
          transcript: rendered,
        })
        .pipe(Effect.flatMap((review) => settle(turn, review)))
    })
  }

/** Decides permission requests with the reviewer and the denial breaker. */
export default Object.freeze({ verdictWith })
