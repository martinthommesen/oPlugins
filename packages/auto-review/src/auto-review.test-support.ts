import {
  Array as Arr,
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  pipe,
} from "effect"
import AuthUnavailable from "./auth-unavailable-error.ts"
import AutoReview from "./auto-review.ts"
import type { Config } from "effect"
import ConversationItem from "./conversation-item.ts"
import DenialBreaker from "./denial-breaker.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import Reviewer from "./reviewer.ts"
import support from "./testing.test-support.ts"

type Review = Reviewer["Service"]["review"]

type ReviewRequest = Parameters<Review>[typeof FIRST]

type Script = () => ReturnType<Review>

type Sessions = Parameters<typeof support.fakeHost>[typeof SECOND]

const CHILD = support.sessionId("ses_child"),
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
    requests: Ref.Ref<readonly ReviewRequest[]>,
    snapshots: Sessions,
  ): Layer.Layer<AutoReview, Config.ConfigError> => {
    const host = support.fakeHost(Option.none(), snapshots),
      recording = Reviewer.of({
        review: (request) =>
          Ref.update(requests, Arr.append(request)).pipe(
            Effect.flatMap(script),
          ),
      }),
      settings = support.settingsFrom({ maxConsecutiveDenials: "2" }),
      strikes = DenialBreaker.layer.pipe(Layer.provide(settings))

    return AutoReview.layer.pipe(
      Layer.provide([
        strikes,
        host,
        Layer.succeed(Reviewer, recording),
        settings,
      ]),
    )
  },
  /*
   * Evaluates each request in turn with one auto-review, and returns the
   * requests its reviewer received.
   */
  evaluateAll = Effect.fn("test.evaluateAll")(function* evaluateAll(
    script: Script,
    evaluations: readonly PermissionEvaluation[],
    snapshots: Sessions = SESSIONS,
  ) {
    const requests = yield* Ref.make<readonly ReviewRequest[]>([]),
      services = yield* Layer.build(autoReviewWith(script, requests, snapshots))

    yield* pipe(
      evaluations,
      Effect.forEach((evaluation) =>
        Context.get(services, AutoReview).evaluate(evaluation),
      ),
    )

    return yield* Ref.get(requests)
  }, Effect.scoped),
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
    Effect.fail(new AuthUnavailable({ reason: "OpenAI is not connected." }))

/** The auto-review tests' sessions, requests, and scripted reviewers. */
export default Object.freeze({
  CHILD,
  ROOT,
  SESSIONS,
  askIn,
  evaluateAll,
  reviewerSays,
  unavailable,
})
