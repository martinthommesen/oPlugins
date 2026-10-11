import { Effect, HashMap, Layer, Option, pipe } from "effect"
import AuthUnavailable from "./auth-unavailable-error.ts"
import AutoReview from "./auto-review.ts"
import ConversationItem from "./conversation-item.ts"
import DenialBreaker from "./denial-breaker.ts"
import FakeReviewer from "./fake-reviewer.test-support.ts"
import type InvalidOptions from "./invalid-options-error.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type Reviewer from "./reviewer.ts"
import support from "./testing.test-support.ts"

type Script = Parameters<typeof FakeReviewer.layer>[typeof FIRST]

type Sessions = Parameters<typeof support.fakeHost>[typeof SECOND]

const CHILD = support.sessionId("ses_child"),
  DENIAL_LIMIT = 2,
  FIRST = 0,
  ROOT = support.sessionId("ses_root"),
  SECOND = 1,
  SESSIONS = HashMap.make(
    [
      ROOT,
      {
        items: [
          ConversationItem.UserMessage({ id: "msg_1", text: "Ship it." }),
        ],
        parentId: Option.none(),
      },
    ],
    [
      CHILD,
      {
        items: [ConversationItem.UserMessage({ id: "msg_2", text: "Push." })],
        parentId: Option.some(ROOT),
      },
    ],
  ) satisfies Sessions,
  /* A permission request that would ask the user, from `session`. */
  askIn = (
    session: PermissionEvaluation["sessionID"],
  ): PermissionEvaluation => ({
    action: "bash",
    effect: "ask",
    resources: ["git push origin main"],
    sessionID: session,
  }),
  /* Auto-review over `snapshots`, with a reviewer that records each request and answers with `script`. */
  autoReviewWith = (
    script: Script,
    snapshots: Sessions = SESSIONS,
  ): Layer.Layer<AutoReview | FakeReviewer | Reviewer, InvalidOptions> => {
    const host = support.fakeHost(Option.none(), snapshots),
      settings = support.settingsFrom({ maxConsecutiveDenials: DENIAL_LIMIT }),
      strikes = DenialBreaker.layer.pipe(Layer.provide(settings))

    return AutoReview.layer.pipe(
      Layer.provide([strikes, host, settings]),
      Layer.provideMerge(FakeReviewer.layer(script)),
    )
  },
  /*
   * Evaluates each request in turn with the block's auto-review, and returns
   * the requests its reviewer received.
   */
  evaluateAll = Effect.fn("test.evaluateAll")(function* evaluateAll(
    evaluations: readonly PermissionEvaluation[],
  ) {
    const autoReview = yield* AutoReview,
      reviewer = yield* FakeReviewer

    yield* pipe(
      evaluations,
      Effect.forEach((evaluation) => autoReview.evaluate(evaluation)),
    )

    return yield* reviewer.requests
  }),
  /* A review with the given outcome. */
  reviewed = (
    outcome: "allow" | "deny",
  ): Effect.Success<ReturnType<Script>> => ({
    assessment: {
      outcome,
      rationale: "Pushes to the default branch.",
      riskLevel: "high",
      userAuthorization: "low",
    },
    model: "codex-auto-review",
  }),
  /* A reviewer that answers every request with `outcome`. */
  reviewerSays =
    (outcome: "allow" | "deny"): Script =>
    () =>
      Effect.succeed(reviewed(outcome)),
  unavailable: Script = () =>
    Effect.fail(AuthUnavailable.make({ reason: "OpenAI is not connected." }))

/** The auto-review tests' sessions, requests, and scripted reviewers. */
export default Object.freeze({
  CHILD,
  ROOT,
  SESSIONS,
  askIn,
  autoReviewWith,
  evaluateAll,
  reviewerSays,
  unavailable,
})
