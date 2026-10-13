import { Deferred, Effect, Fiber, Match, Option } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type { Scope } from "effect"
import Script from "./tracker.test-support.ts"
import UsageMeter from "./usage-meter.ts"
import type UsageTracker from "./usage-tracker.ts"
import type { Vitest } from "@effect/vitest"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Script | Scope.Scope | UsageTracker>
}

/** A request to Anthropic, held until the test lets it finish. */
interface Held {
  /** Lets the held request finish. */
  readonly release: Deferred.Deferred<boolean>
  /** Completes once the request reached the meter. */
  readonly started: Deferred.Deferred<boolean>
}

const B_PERCENT = 50,
  FIRST = 0,
  ONCE = 1,
  READ = UsageMeter.Outcome.Read({ reading: Script.READING }),
  /** The usage of the account the connection switches to. */
  READING_B = {
    plan: Option.none<string>(),
    windows: [
      {
        label: "5-hour",
        resetsAt: Option.none<number>(),
        usedPercent: Option.some(B_PERCENT),
      },
    ],
  },
  READ_B = Effect.succeed(UsageMeter.Outcome.Read({ reading: READING_B })),
  TWICE = 2,
  /* The windows of Claude's measurement in `states`, if it has one. */
  claudeWindows = (
    states: Effect.Success<typeof Script.states>,
  ): Option.Option<readonly (typeof Script.READING.windows)[number][]> =>
    Option.fromUndefinedOr(states[FIRST]).pipe(
      Option.flatMap((state) =>
        Match.value(state).pipe(
          Match.tag("Measured", (measured) => Option.some(measured.windows)),
          Match.orElse(() => Option.none()),
        ),
      ),
    ),
  /* Holds each request to Anthropic until the test releases it. */
  holding = Effect.gen(function* holding() {
    const release = yield* Deferred.make<boolean>(),
      started = yield* Deferred.make<boolean>(),
      waiting = Deferred.succeed(started, true).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as(READ),
      )

    yield* Script.answer("Anthropic", waiting)

    return { release, started } satisfies Held
  }),
  /* Starts a report once the held request reached the meter, after `meanwhile`. */
  reportAfter = (
    held: Held,
    meanwhile: Effect.Effect<void, never, Script>,
  ): Effect.Effect<
    Fiber.Fiber<Effect.Success<typeof Script.states>>,
    never,
    Script | UsageTracker
  > =>
    Deferred.await(held.started).pipe(
      Effect.andThen(meanwhile),
      Effect.andThen(
        Effect.forkChild(Script.states, { startImmediately: true }),
      ),
    ),
  /* Switches Claude's connection to account B, whose service answers with `READING_B`. */
  switchedToB = Script.connect("anthropic", Script.signedIn("claude-b")).pipe(
    Effect.andThen(Script.answer("Anthropic", READ_B)),
  )

describe("an abandoned refresh", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("releases the lock without caching the interrupted attempt", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const armed = yield* holding,
          first = yield* Effect.forkChild(Script.states)

        yield* Deferred.await(armed.started)
        yield* Fiber.interrupt(first)
        yield* Script.answer("Anthropic", Effect.succeed(READ))
        expect(claudeWindows(yield* Script.states)).toStrictEqual(
          Option.some(Script.READING.windows),
        )
        expect(yield* Script.countOf("Anthropic")).toBe(TWICE)
      }),
    )
  })
})

describe("reports that overlap", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("share one request to each service", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const armed = yield* holding,
          first = yield* Effect.forkChild(Script.states),
          second = yield* reportAfter(armed, Effect.void)

        yield* Deferred.succeed(armed.release, true)

        expect(yield* Fiber.join(second)).toStrictEqual(
          yield* Fiber.join(first),
        )
        expect(yield* Script.countOf("Anthropic")).toBe(ONCE)
      }),
    )
  })
})

describe("a connection that changes account during a request", () => {
  test.layer(Script.layer)((it: Tests) => {
    it.effect("reports the new account's usage, never the old one's", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const armed = yield* holding,
          first = yield* Effect.forkChild(Script.states),
          second = yield* reportAfter(armed, switchedToB)

        yield* Deferred.succeed(armed.release, true)

        expect(claudeWindows(yield* Fiber.join(first))).toStrictEqual(
          Option.some(Script.READING.windows),
        )
        expect(claudeWindows(yield* Fiber.join(second))).toStrictEqual(
          Option.some(READING_B.windows),
        )
        expect(claudeWindows(yield* Script.states)).toStrictEqual(
          Option.some(READING_B.windows),
        )
        expect(yield* Script.countOf("Anthropic")).toBe(TWICE)
      }),
    )
  })
})
