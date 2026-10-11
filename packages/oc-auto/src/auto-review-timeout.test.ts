import { Effect, Fiber, Layer, Ref } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import AutoReview from "./auto-review.ts"
import DenialBreaker from "./denial-breaker.ts"
import HangingHost from "./hanging-host.test-support.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import Reviewer from "./reviewer.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import support from "./testing.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<AutoReview | HangingHost | Scope.Scope>
}

/* A one-second deadline over a host that never answers and records being interrupted. */
const deadlineServices = (): Layer.Layer<
  AutoReview | HangingHost,
  PluginOptionsError
> => {
  const settings = support.settingsFrom({ timeout: "1 second" }),
    stalledReviewer = Reviewer.of({ review: () => Effect.never }),
    strikes = DenialBreaker.layer.pipe(Layer.provide(settings))

  return AutoReview.layer.pipe(
    Layer.provide([
      Layer.succeed(Reviewer, stalledReviewer),
      strikes,
      settings,
    ]),
    Layer.provideMerge(HangingHost.layer),
  )
}

describe("review deadline", () => {
  test.layer(deadlineServices())((it: Tests) => {
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
            { interrupted } = yield* HangingHost,
            waiting = yield* (yield* AutoReview)
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
})
