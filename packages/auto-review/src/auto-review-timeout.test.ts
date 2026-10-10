import { Context, Effect, Fiber, Layer, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import AutoReview from "./auto-review.ts"
import type { Config } from "effect"
import DenialBreaker from "./denial-breaker.ts"
import Host from "./host.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import Reviewer from "./reviewer.ts"
import { TestClock } from "effect/testing"
import support from "./testing.test-support.ts"

/* A one-second deadline over a host that never answers and records being interrupted. */
const deadlineServices = (
  interrupted: Ref.Ref<boolean>,
): Layer.Layer<AutoReview, Config.ConfigError> => {
  const hangingHost = Host.of({
      openAiCredential: Effect.succeedNone,
      session: () =>
        Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
    }),
    settings = support.settingsFrom({ timeout: "1 second" }),
    stalledReviewer = Reviewer.of({ review: () => Effect.never }),
    strikes = DenialBreaker.layer.pipe(Layer.provide(settings))

  return AutoReview.layer.pipe(
    Layer.provide([
      Layer.succeed(Host, hangingHost),
      Layer.succeed(Reviewer, stalledReviewer),
      strikes,
      settings,
    ]),
  )
}

describe("review deadline", () => {
  it.effect(
    "includes context acquisition in the deadline and interrupts it",
    () =>
      Effect.gen(function* contextDeadline() {
        expect.hasAssertions()

        const evaluation: PermissionEvaluation = {
            action: "bash",
            effect: "ask",
            resources: ["git push origin main"],
            sessionID: support.sessionId("ses_root"),
          },
          interrupted = yield* Ref.make(false),
          services = yield* Layer.build(deadlineServices(interrupted)),
          waiting = yield* Context.get(services, AutoReview)
            .evaluate(evaluation)
            .pipe(Effect.forkScoped)

        yield* TestClock.adjust("1 second")
        yield* Fiber.join(waiting)

        expect(evaluation.effect).toBe("ask")
        expect(evaluation.message).toContain("did not finish within")
        expect(yield* Ref.get(interrupted)).toBe(true)
      }),
  )
})
