import { Deferred, Effect, Fiber, Match, Ref } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import HostScript from "./host-tracker.test-support.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import UsageTracker from "./usage-tracker.ts"
import type { Vitest } from "@effect/vitest"

interface Tests {
  readonly effect: Vitest.Test<HostScript | Scope.Scope | UsageTracker>
}

const states = UsageTracker.pipe(
    Effect.flatMap((tracker) => tracker.report),
    Effect.map((report) =>
      report.subscriptions.map((subscription) =>
        Match.valueTags(subscription.state, {
          Disconnected: () => "disconnected",
          Failed: () => "failed",
          Ineligible: () => "ineligible",
          Measured: () => "measured",
        }),
      ),
    ),
  ),
  waiting = Effect.gen(function* holdNetwork() {
    const entered = yield* Deferred.make<boolean>(),
      release = yield* Deferred.make<boolean>(),
      response = Deferred.succeed(entered, true).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.asVoid,
      )

    return { entered, release, response }
  })

describe("credential replacement during HTTP", () => {
  test.layer(HostScript.layer)((it: Tests) => {
    it.effect(
      "discards a response for a replaced token and preserves the original interval",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const held = yield* waiting,
            script = yield* HostScript,
            task = yield* Ref.set(script.gate, held.response).pipe(
              Effect.andThen(Effect.forkChild(states)),
            )

          yield* Deferred.await(held.entered)
          yield* Ref.set(
            script.resolver,
            Effect.succeed(HostScript.oauth("synthetic-b")),
          )
          yield* Deferred.succeed(held.release, true)
          expect(yield* Fiber.join(task)).toStrictEqual(["failed", "measured"])
          expect(yield* states).toStrictEqual(["failed", "measured"])
          yield* TestClock.adjust("3 minutes")
          expect(yield* states).toStrictEqual(["measured", "measured"])
        }),
    )
  })
})

describe("account selection during HTTP", () => {
  test.layer(HostScript.layer)((it: Tests) => {
    it.effect(
      "discards a response when metadata selects another account with the same token",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const held = yield* waiting,
            script = yield* HostScript,
            task = yield* Ref.set(script.codexGate, held.response).pipe(
              Effect.andThen(Effect.forkChild(states)),
            )

          yield* Deferred.await(held.entered)
          yield* Ref.set(
            script.codexResolver,
            Effect.succeed(HostScript.oauth("synthetic-a", "other-account")),
          )
          yield* Deferred.succeed(held.release, true)
          expect(yield* Fiber.join(task)).toStrictEqual(["measured", "failed"])
          expect(yield* states).toStrictEqual(["measured", "measured"])
        }),
    )
  })
})

describe("post-request resolution", () => {
  test.layer(HostScript.layer)((it: Tests) => {
    it.effect(
      "does not publish the completed measurement when revalidation hangs",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const held = yield* waiting,
            script = yield* HostScript,
            task = yield* Ref.set(script.gate, held.response).pipe(
              Effect.andThen(Effect.forkChild(states)),
            )

          yield* Deferred.await(held.entered)
          yield* Ref.set(script.resolver, Effect.never)
          yield* Deferred.succeed(held.release, true)
          yield* TestClock.adjust("45 seconds")
          expect(yield* Fiber.join(task)).toStrictEqual(["failed", "measured"])
        }),
    )
  })
})

describe("whole report budget", () => {
  test.layer(HostScript.layer)((it: Tests) => {
    it.effect(
      "shares seventy-five seconds across resolution, HTTP and revalidation",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const grant = HostScript.oauth("synthetic-a"),
            initial = Effect.sleep("30 seconds").pipe(Effect.as(grant)),
            script = yield* HostScript,
            stage = Effect.sleep("10 seconds").pipe(
              Effect.andThen(Ref.set(script.resolver, Effect.never)),
            ),
            task = yield* Effect.all([
              Ref.set(script.resolver, initial),
              Ref.set(script.gate, stage),
            ]).pipe(Effect.andThen(Effect.forkChild(states)))

          yield* TestClock.adjust("75 seconds")
          expect(yield* Fiber.join(task)).toStrictEqual(["failed", "measured"])
        }),
    )
  })
})
