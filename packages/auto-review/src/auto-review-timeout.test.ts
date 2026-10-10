import { Effect, Fiber, Layer, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { sessionId, settingsFrom } from "./testing.ts"
import { AutoReview } from "./auto-review.ts"
import type { Config } from "effect"
import { DenialBreaker } from "./denial-breaker.ts"
import { Host } from "./host.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Reviewer } from "./reviewer.ts"
import { TestClock } from "effect/testing"

const deadlineServices = (
  interrupted: Ref.Ref<boolean>,
): Layer.Layer<AutoReview, Config.ConfigError> => {
  const settings = settingsFrom({ timeout: "1 second" })

  const host = Layer.succeed(
    Host,
    Host.of({
      openAiCredential: Effect.succeedNone,
      session: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
    }),
  )

  const reviewer = Layer.succeed(
    Reviewer,
    Reviewer.of({
      review: () => Effect.never,
    }),
  )

  const breaker = DenialBreaker.layer.pipe(Layer.provide(settings))

  return AutoReview.layer.pipe(
    Layer.provide([host, reviewer, breaker, settings]),
  )
}

describe("review deadline", () => {
  it.effect(
    "includes context acquisition in the deadline and interrupts it",
    () =>
      Effect.gen(function* contextDeadline() {
        const interrupted = yield* Ref.make(false)

        const evaluation: PermissionEvaluation = {
          action: "bash",
          effect: "ask",
          resources: ["git push origin main"],
          sessionID: sessionId("ses_root"),
        }

        const fiber = yield* Effect.gen(function* evaluate() {
          const autoReview = yield* AutoReview

          yield* autoReview.evaluate(evaluation)
        }).pipe(
          Effect.provide(deadlineServices(interrupted)),
          Effect.forkScoped,
        )

        yield* TestClock.adjust("1 second")
        yield* Fiber.join(fiber)

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain("did not finish within")
        expect(yield* Ref.get(interrupted)).toBe(true)
      }),
  )
})
