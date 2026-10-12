import { Effect, Layer } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import BreakerDecision from "./breaker-decision.ts"
import DenialBreaker from "./denial-breaker.ts"
import PluginOptions from "./plugin-options.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"

/** The `it` of a `test.layer` block: `it.effect`, given a breaker. */
interface Tests {
  readonly effect: Vitest.Test<DenialBreaker | Scope.Scope>
}

const FIRST_DENIAL = 1,
  FIRST_TURN = { sessionId: "session", userMessageId: "turn-1" },
  OTHER_SESSION = { sessionId: "other", userMessageId: "turn-1" },
  SECOND_DENIAL = 2,
  SECOND_TURN = { sessionId: "session", userMessageId: "turn-2" },
  THIRD_DENIAL = 3,
  TOTAL_LIMIT = 4,
  /* Escalates at three denials in a row or four in total. */
  breakerLimits = PluginOptions.fromOptions({
    maxConsecutiveDenials: THIRD_DENIAL,
    maxTotalDenials: TOTAL_LIMIT,
  }),
  /** The block's breaker's decision on a denial right after an approval. */
  deniedAfterApproval = Effect.gen(function* deniedAfterApproval() {
    const breaker = yield* DenialBreaker

    yield* breaker.recordApproval(FIRST_TURN)

    return yield* breaker.recordDenial(FIRST_TURN)
  }),
  /** A breaker of its own for one test. */
  freshBreaker = DenialBreaker.layer.pipe(Layer.provide(breakerLimits))

describe("denial breaker", () => {
  test.layer(freshBreaker)((it: Tests) => {
    it.effect("escalates after three consecutive denials", () =>
      Effect.gen(function* consecutive() {
        expect.hasAssertions()

        const breaker = yield* DenialBreaker,
          decisions = yield* Effect.all([
            breaker.recordDenial(FIRST_TURN),
            breaker.recordDenial(FIRST_TURN),
            breaker.recordDenial(FIRST_TURN),
          ])

        expect(decisions).toStrictEqual([
          BreakerDecision.Deny({ consecutive: 1, total: 1 }),
          BreakerDecision.Deny({ consecutive: 2, total: 2 }),
          BreakerDecision.Escalate({ consecutive: 3, total: 3 }),
        ])
      }),
    )
  })

  test.layer(freshBreaker)((it: Tests) => {
    it.effect("restarts the consecutive count after an approval", () =>
      Effect.gen(function* approvalResets() {
        expect.hasAssertions()

        const breaker = yield* DenialBreaker

        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordApproval(FIRST_TURN)

        expect(yield* breaker.recordDenial(FIRST_TURN)).toStrictEqual(
          BreakerDecision.Deny({ consecutive: 1, total: 3 }),
        )
      }),
    )
  })
})

describe("denial breaker totals", () => {
  test.layer(freshBreaker)((it: Tests) => {
    it.effect("escalates when total denials in a turn reach the limit", () =>
      Effect.gen(function* total() {
        expect.hasAssertions()

        const breaker = yield* DenialBreaker

        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordApproval(FIRST_TURN)
        yield* breaker.recordDenial(FIRST_TURN)

        expect(yield* breaker.recordDenial(FIRST_TURN)).toStrictEqual(
          BreakerDecision.Escalate({ consecutive: 2, total: 4 }),
        )
      }),
    )
  })

  test.layer(freshBreaker)((it: Tests) => {
    it.effect("counts each turn and session separately", () =>
      Effect.gen(function* separate() {
        expect.hasAssertions()

        const breaker = yield* DenialBreaker

        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordDenial(FIRST_TURN)

        expect([
          yield* breaker.recordDenial(SECOND_TURN),
          yield* breaker.recordDenial(OTHER_SESSION),
        ]).toStrictEqual([
          BreakerDecision.Deny({ consecutive: 1, total: 1 }),
          BreakerDecision.Deny({ consecutive: 1, total: 1 }),
        ])
      }),
    )
  })
})

describe("denial breaker escalation", () => {
  test.layer(freshBreaker)((it: Tests) => {
    it.effect("keeps asking after escalation until a new user turn", () =>
      Effect.gen(function* stickyEscalation() {
        expect.hasAssertions()

        const breaker = yield* DenialBreaker

        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordApproval(FIRST_TURN)

        expect([
          yield* breaker.recordDenial({
            sessionId: "session",
            userMessageId: "turn-1",
          }),
          yield* deniedAfterApproval,
        ]).toStrictEqual([
          BreakerDecision.Escalate({ consecutive: 1, total: 4 }),
          BreakerDecision.Escalate({ consecutive: 1, total: 5 }),
        ])
      }),
    )
  })

  test.layer(freshBreaker)((it: Tests) => {
    it.effect("does not let late approvals erase another turn's denials", () =>
      Effect.gen(function* lateApproval() {
        expect.hasAssertions()

        const breaker = yield* DenialBreaker

        yield* breaker.recordDenial(FIRST_TURN)
        yield* breaker.recordDenial(SECOND_TURN)
        yield* breaker.recordDenial(SECOND_TURN)
        yield* breaker.recordApproval(FIRST_TURN)

        expect([
          yield* breaker.recordDenial(SECOND_TURN),
          yield* breaker.recordDenial(FIRST_TURN),
        ]).toStrictEqual([
          BreakerDecision.Escalate({ consecutive: 3, total: 3 }),
          BreakerDecision.Deny({ consecutive: 1, total: 2 }),
        ])
      }),
    )
  })
})

describe("denial breaker concurrency", () => {
  test.layer(freshBreaker)((it: Tests) => {
    it.effect("counts concurrent denials without losing updates", () =>
      Effect.gen(function* concurrentDenials() {
        expect.hasAssertions()

        const breaker = yield* DenialBreaker,
          decisions = yield* Effect.all(
            [
              breaker.recordDenial(FIRST_TURN),
              breaker.recordDenial(FIRST_TURN),
              breaker.recordDenial(FIRST_TURN),
            ],
            { concurrency: "unbounded" },
          )

        expect(decisions.map((decision) => decision.total)).toStrictEqual([
          FIRST_DENIAL,
          SECOND_DENIAL,
          THIRD_DENIAL,
        ])
      }),
    )
  })
})
