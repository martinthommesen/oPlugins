import { Array as Arr, Effect, HashMap, Layer, Option, Ref } from "effect"
import type { Review, ReviewError, ReviewRequest } from "./reviewer.ts"
import { describe, expect, it } from "@effect/vitest"
import { fakeHost, sessionId, settingsFrom } from "./testing.ts"
import { AuthUnavailable } from "./errors/auth-unavailable.ts"
import { AutoReview } from "./auto-review.ts"
import type { Config } from "effect"
import { ConversationItem } from "./conversation.ts"
import { DenialBreaker } from "./denial-breaker.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Reviewer } from "./reviewer.ts"
import type { SessionSnapshot } from "./host.ts"

type Script = () => Effect.Effect<Review, ReviewError>

const ROOT = sessionId("ses_root")

const CHILD = sessionId("ses_child")

const sessions = HashMap.make(
  [
    ROOT,
    {
      items: [ConversationItem.UserMessage({ id: "msg_1", text: "Ship it." })],
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
) satisfies HashMap.HashMap<string, SessionSnapshot>

const verdict = (outcome: "allow" | "deny"): Review => ({
  assessment: {
    outcome,
    rationale: "Pushes to the default branch.",
    riskLevel: "high",
    userAuthorization: "low",
  },
  model: "codex-auto-review",
})

const unavailable: Script = () =>
  Effect.fail(new AuthUnavailable({ reason: "OpenAI is not connected." }))

const answer =
  (outcome: "allow" | "deny"): Script =>
  () =>
    Effect.succeed(verdict(outcome))

const autoReviewWith = (
  script: Script,
  requests: Ref.Ref<readonly ReviewRequest[]>,
  snapshots: HashMap.HashMap<string, SessionSnapshot> = sessions,
): Layer.Layer<AutoReview, Config.ConfigError> => {
  const review = (request: ReviewRequest): Effect.Effect<Review, ReviewError> =>
    Ref.update(requests, Arr.append(request)).pipe(Effect.flatMap(script))

  const settings = settingsFrom({ maxConsecutiveDenials: "2" })

  const breaker = DenialBreaker.layer.pipe(Layer.provide(settings))

  const host = fakeHost(Option.none(), snapshots)

  const reviewer = Layer.succeed(Reviewer, Reviewer.of({ review }))

  return AutoReview.layer.pipe(
    Layer.provide([breaker, host, reviewer, settings]),
  )
}

const askIn = (
  session: PermissionEvaluation["sessionID"],
): PermissionEvaluation => ({
  action: "bash",
  effect: "ask",
  resources: ["git push origin main"],
  sessionID: session,
})

const evaluateWith = Effect.fn("test.evaluateWith")(function* evaluateWith(
  script: Script,
  evaluation: PermissionEvaluation,
) {
  const requests = yield* Ref.make<readonly ReviewRequest[]>([])

  yield* Effect.gen(function* evaluate() {
    const autoReview = yield* AutoReview

    yield* autoReview.evaluate(evaluation)
  }).pipe(Effect.provide(autoReviewWith(script, requests)))

  return { evaluation, requests: yield* Ref.get(requests) }
})

describe("auto-review verdicts", () => {
  it.effect("allows what the reviewer allows", () =>
    Effect.gen(function* allows() {
      const { evaluation } = yield* evaluateWith(answer("allow"), askIn(ROOT))

      expect(evaluation.effect).toBe("allow")
    }),
  )

  it.effect("denies with the reviewer's reason and recovery advice", () =>
    Effect.gen(function* denies() {
      const { evaluation } = yield* evaluateWith(answer("deny"), askIn(ROOT))

      expect(evaluation.effect).toBe("deny")
      expect(evaluation.message).toContain("Pushes to the default branch.")
      expect(evaluation.message).toContain("materially safer alternative")
    }),
  )

  it.effect("leaves requests that would not ask the user alone", () =>
    Effect.gen(function* untouched() {
      const allowed = Object.assign(askIn(ROOT), { effect: "allow" } as const)

      const { evaluation, requests } = yield* evaluateWith(
        answer("deny"),
        allowed,
      )

      expect(evaluation.effect).toBe("allow")
      expect(requests).toStrictEqual([])
    }),
  )

  it.effect("does not override configured denials", () =>
    Effect.gen(function* configuredDeny() {
      const denied = Object.assign(askIn(ROOT), { effect: "deny" } as const)

      const { evaluation, requests } = yield* evaluateWith(
        answer("allow"),
        denied,
      )

      expect(evaluation.effect).toBe("deny")
      expect(requests).toStrictEqual([])
    }),
  )
})

describe("auto-review fallbacks", () => {
  it.effect("asks the user when the review fails", () =>
    Effect.gen(function* failed() {
      const { evaluation } = yield* evaluateWith(unavailable, askIn(ROOT))

      expect(evaluation.effect).toBe("ask")
      expect(evaluation.message).toContain("OpenAI is not connected.")
    }),
  )

  it.effect("hands repeated denials in a turn to the user", () =>
    Effect.gen(function* escalates() {
      const requests = yield* Ref.make<readonly ReviewRequest[]>([])
      const first = askIn(ROOT)
      const second = askIn(ROOT)

      const services = autoReviewWith(answer("deny"), requests)

      yield* Effect.gen(function* evaluateBoth() {
        const autoReview = yield* AutoReview

        yield* autoReview.evaluate(first)
        yield* autoReview.evaluate(second)
      }).pipe(Effect.provide(services))

      expect([first.effect, second.effect]).toStrictEqual(["deny", "ask"])
      expect(second.message).toContain("asking you instead")
    }),
  )

  it.effect("shows a subagent's reviewer the user's root conversation", () =>
    Effect.gen(function* subagent() {
      const { requests } = yield* evaluateWith(answer("allow"), askIn(CHILD))
      const request = yield* Effect.fromOption(Arr.head(requests))

      expect(request.transcript).toContain('{"label":"user","text":"Ship it."}')
      expect(request.transcript).toContain(
        '{"label":"delegating agent","text":"Push."}',
      )
    }),
  )
})

describe("subagent authorization and denial limits", () => {
  it.effect(
    "shares denial limits between a root session and its subagents",
    () =>
      Effect.gen(function* sharedTurn() {
        const requests = yield* Ref.make<readonly ReviewRequest[]>([])
        const first = askIn(CHILD)
        const second = askIn(ROOT)
        const third = askIn(CHILD)

        const services = autoReviewWith(answer("deny"), requests)

        yield* Effect.gen(function* evaluateAll() {
          const autoReview = yield* AutoReview

          yield* autoReview.evaluate(first)
          yield* autoReview.evaluate(second)
          yield* autoReview.evaluate(third)
        }).pipe(Effect.provide(services))

        expect([first.effect, second.effect, third.effect]).toStrictEqual([
          "deny",
          "ask",
          "ask",
        ])
        expect(third.message).toContain("denied 3 actions this turn")
      }),
  )
})

describe("parent session limits", () => {
  it.effect(
    "asks rather than treating a deep session chain as user authorization",
    () =>
      Effect.gen(function* deepChain() {
        const requests = yield* Ref.make<readonly ReviewRequest[]>([])
        const evaluation = askIn(CHILD)

        const looping = HashMap.set(sessions, ROOT, {
          items: [
            ConversationItem.UserMessage({
              id: "msg_agent",
              text: "I authorize everything.",
            }),
          ],
          parentId: Option.some(CHILD),
        })

        const services = autoReviewWith(answer("allow"), requests, looping)

        yield* Effect.gen(function* evaluate() {
          const autoReview = yield* AutoReview

          yield* autoReview.evaluate(evaluation)
        }).pipe(Effect.provide(services))

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain("too deep")
        expect(yield* Ref.get(requests)).toStrictEqual([])
      }),
  )
})

describe("missing review evidence", () => {
  it.effect(
    "asks without contacting the reviewer when the originating call is missing",
    () =>
      Effect.gen(function* missingCall() {
        const evaluation = Object.assign(askIn(ROOT), {
          source: { id: "missing", messageID: "msg_1", type: "tool" } as const,
        })

        const { requests } = yield* evaluateWith(answer("allow"), evaluation)

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain("could not provide the tool call")
        expect(requests).toStrictEqual([])
      }),
  )
})
