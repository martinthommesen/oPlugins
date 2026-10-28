import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Fiber,
  Match,
  Option,
  Record as Rec,
  Redacted,
  Ref,
} from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type { Scope } from "effect"
import Script from "./tracker.test-support.ts"
import { TestClock } from "effect/testing"
import UsageMeter from "./usage-meter.ts"
import type UsageTracker from "./usage-tracker.ts"
import type { Vitest } from "@effect/vitest"

interface Tests {
  readonly effect: Vitest.Test<Script | Scope.Scope | UsageTracker>
}

const ASKED_WAIT_MINUTES = 10,
  FIRST = 0,
  LIMITED = Effect.succeed(
    UsageMeter.Outcome.Limited({
      problem: "Wait.",
      wait: Duration.minutes(ASKED_WAIT_MINUTES),
    }),
  ),
  MINIMUM_MS = 180_000,
  ONCE = 1,
  READ = UsageMeter.Outcome.Read({ reading: Script.READING }),
  RESOLUTION_MS = 28_000,
  TWICE = 2,
  measurementTimes = (
    values: readonly Effect.Success<typeof Script.states>[number][],
  ): readonly Option.Option<number>[] =>
    values.map((state) =>
      Match.value(state).pipe(
        Match.tag("Measured", (measured) => Option.some(measured.measuredAt)),
        Match.orElse(() => Option.none<number>()),
      ),
    ),
  /* A delayed credential response and independently recorded dispatch times. */
  renewal = Effect.gen(function* armRenewal() {
    const dispatched = yield* Ref.make<readonly number[]>([]),
      grant = {
        accountId: Option.some("account"),
        token: Redacted.make("token"),
      },
      ready = yield* Deferred.make<boolean>(),
      reconnected = Script.signedIn("claude-a"),
      renewing = yield* Script,
      reset = Ref.update(
        renewing.connections,
        Rec.set("anthropic", reconnected),
      ),
      resolving = Deferred.succeed(ready, true).pipe(
        Effect.andThen(Effect.sleep("28 seconds")),
        Effect.andThen(reset),
        Effect.as(Option.some(grant)),
      )

    yield* Script.connect("anthropic", Script.withAccess("claude-a", resolving))
    yield* Script.answer(
      "Anthropic",
      Clock.currentTimeMillis.pipe(
        Effect.tap((now) => Ref.update(dispatched, (times) => [...times, now])),
        Effect.as(READ),
      ),
    )
    yield* Effect.forkChild(Script.states).pipe(
      Effect.tap(() => Deferred.await(ready)),
      Effect.tap(() => TestClock.adjust("28 seconds")),
      Effect.flatMap((fiber) => Fiber.join(fiber)),
    )
    yield* Script.connect("anthropic", Script.signedIn("claude-a"))

    return yield* Effect.all({
      dispatched: Effect.succeed(dispatched),
      measured: Script.states,
    })
  })

describe("per-identity scheduling", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect(
      "reuses A after measuring B while A's interval is still young",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          yield* Script.states
          yield* Script.connect("anthropic", Script.signedIn("claude-b"))
          yield* Script.states
          yield* Script.connect("anthropic", Script.signedIn("claude-a"))
          yield* Script.states

          expect(yield* Script.countOf("Anthropic")).toBe(TWICE)
        }),
    )
  })

  test.layer(Script.layer)((it: Tests) => {
    it.effect("preserves A's longer service wait across A to B to A", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        yield* Script.answer("Anthropic", LIMITED)
        yield* Script.states
        yield* Script.connect("anthropic", Script.signedIn("claude-b"))
        yield* Script.states
        yield* Script.connect("anthropic", Script.signedIn("claude-a"))
        yield* TestClock.adjust("3 minutes")
        yield* Script.states

        expect(yield* Script.countOf("Anthropic")).toBe(TWICE)
      }),
    )
  })
})

describe("credential resolution timing", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect(
      "starts the interval and measurement time at dispatch, after renewal",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const observation = yield* renewal
          yield* TestClock.adjust("152 seconds")
          yield* Script.states

          expect(yield* Script.countOf("Anthropic")).toBe(ONCE)
          yield* TestClock.adjust("28 seconds")
          yield* Script.states
          expect(yield* Ref.get(observation.dispatched)).toStrictEqual([
            RESOLUTION_MS,
            RESOLUTION_MS + MINIMUM_MS,
          ])
          expect(measurementTimes(observation.measured)[FIRST]).toStrictEqual(
            Option.some(RESOLUTION_MS),
          )
        }),
    )
  })
})

describe("rate-limit receipt timing", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect(
      "starts Retry-After when the service responds, not before the HTTP request",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const ready = yield* Deferred.make<boolean>(),
            response = Deferred.succeed(ready, true).pipe(
              Effect.andThen(Effect.sleep("20 seconds")),
              Effect.andThen(LIMITED),
            ),
            task = yield* Script.answer("Anthropic", response).pipe(
              Effect.andThen(Effect.forkChild(Script.states)),
            )

          yield* Deferred.await(ready)
          yield* TestClock.adjust("20 seconds")
          yield* Fiber.join(task)
          yield* Script.answer("Anthropic", LIMITED)
          yield* TestClock.adjust("580 seconds").pipe(
            Effect.andThen(Script.states),
          )
          expect(yield* Script.countOf("Anthropic")).toBe(ONCE)
          yield* TestClock.adjust("20 seconds").pipe(
            Effect.andThen(Script.states),
          )
          expect(yield* Script.countOf("Anthropic")).toBe(TWICE)
        }),
    )
  })
})
