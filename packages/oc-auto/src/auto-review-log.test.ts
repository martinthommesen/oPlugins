import { Effect, Layer } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import fixtures from "./auto-review.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    | CapturedLogs
    | Layer.Success<ReturnType<typeof fixtures.autoReviewWith>>
    | Scope.Scope
  >
}

const { ROOT, askIn, autoReviewWith, evaluateAll, reviewerSays, unavailable } =
    fixtures,
  /** A reviewer that denies every request. */
  denies = reviewerSays("deny")

describe("auto-review verdict records", () => {
  test.layer(Layer.merge(CapturedLogs.layer, autoReviewWith(denies)))(
    (it: Tests) => {
      it.effect(
        "log the verdict as metadata and the rationale only at debug level",
        () =>
          Effect.gen(function* reviewed() {
            expect.hasAssertions()

            yield* evaluateAll([askIn(ROOT)])

            expect(yield* (yield* CapturedLogs).records).toStrictEqual([
              {
                annotations: {
                  action: "bash",
                  model: "codex-auto-review",
                  verdict: "deny",
                },
                level: "Info",
                message: "auto_review_verdict",
              },
              {
                annotations: {
                  action: "bash",
                  rationale: "Pushes to the default branch.",
                },
                level: "Debug",
                message: "auto_review_rationale",
              },
            ])
          }),
      )
    },
  )
})

describe("auto-review failure records", () => {
  test.layer(Layer.merge(CapturedLogs.layer, autoReviewWith(unavailable)))(
    (it: Tests) => {
      it.effect(
        "log a failed review as metadata and its reason only at debug level",
        () =>
          Effect.gen(function* failed() {
            expect.hasAssertions()

            yield* evaluateAll([askIn(ROOT)])

            expect(yield* (yield* CapturedLogs).records).toStrictEqual([
              {
                annotations: { error: "AuthUnavailable" },
                level: "Warn",
                message: "auto_review_failed",
              },
              {
                annotations: { reason: "OpenAI is not connected." },
                level: "Debug",
                message: "auto_review_failure_reason",
              },
              {
                annotations: { action: "bash", verdict: "ask" },
                level: "Info",
                message: "auto_review_verdict",
              },
            ])
          }),
      )
    },
  )
})
