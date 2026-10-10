import { BreakerDecision, DenialBreaker } from "./denial-breaker.ts"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { settingsFrom } from "./testing.ts"

const breakerLayer = DenialBreaker.layer.pipe(
  Layer.provide(
    settingsFrom({ maxConsecutiveDenials: "3", maxTotalDenials: "4" }),
  ),
)

const FIRST_TURN = { sessionId: "session", userMessageId: "turn-1" }

const SECOND_TURN = { sessionId: "session", userMessageId: "turn-2" }

const OTHER_SESSION = { sessionId: "other", userMessageId: "turn-1" }

const FIRST_DENIAL = 1

const SECOND_DENIAL = 2

const THIRD_DENIAL = 3

describe("denial breaker", () => {
  it.effect("escalates after three consecutive denials", () =>
    Effect.gen(function* consecutive() {
      const breaker = yield* DenialBreaker

      const first = yield* breaker.recordDenial(FIRST_TURN)
      const second = yield* breaker.recordDenial(FIRST_TURN)
      const third = yield* breaker.recordDenial(FIRST_TURN)

      expect([first, second, third]).toStrictEqual([
        BreakerDecision.Deny({ consecutive: 1, total: 1 }),
        BreakerDecision.Deny({ consecutive: 2, total: 2 }),
        BreakerDecision.Escalate({ consecutive: 3, total: 3 }),
      ])
    }).pipe(Effect.provide(breakerLayer)),
  )

  it.effect("restarts the consecutive count after an approval", () =>
    Effect.gen(function* approvalResets() {
      const breaker = yield* DenialBreaker

      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordApproval(FIRST_TURN)
      const afterApproval = yield* breaker.recordDenial(FIRST_TURN)

      expect(afterApproval).toStrictEqual(
        BreakerDecision.Deny({ consecutive: 1, total: 3 }),
      )
    }).pipe(Effect.provide(breakerLayer)),
  )
})

describe("denial breaker totals", () => {
  it.effect("escalates when total denials in a turn reach the limit", () =>
    Effect.gen(function* total() {
      const breaker = yield* DenialBreaker

      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordApproval(FIRST_TURN)
      yield* breaker.recordDenial(FIRST_TURN)
      const fourth = yield* breaker.recordDenial(FIRST_TURN)

      expect(fourth).toStrictEqual(
        BreakerDecision.Escalate({ consecutive: 2, total: 4 }),
      )
    }).pipe(Effect.provide(breakerLayer)),
  )

  it.effect("counts each turn and session separately", () =>
    Effect.gen(function* separate() {
      const breaker = yield* DenialBreaker

      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordDenial(FIRST_TURN)
      const newTurn = yield* breaker.recordDenial(SECOND_TURN)
      const otherSession = yield* breaker.recordDenial(OTHER_SESSION)

      expect([newTurn, otherSession]).toStrictEqual([
        BreakerDecision.Deny({ consecutive: 1, total: 1 }),
        BreakerDecision.Deny({ consecutive: 1, total: 1 }),
      ])
    }).pipe(Effect.provide(breakerLayer)),
  )
})

describe("denial breaker escalation", () => {
  it.effect("keeps asking after escalation until a new user turn", () =>
    Effect.gen(function* stickyEscalation() {
      const breaker = yield* DenialBreaker

      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordApproval(FIRST_TURN)

      const fourth = yield* breaker.recordDenial({
        sessionId: "session",
        userMessageId: "turn-1",
      })

      yield* breaker.recordApproval(FIRST_TURN)
      const fifth = yield* breaker.recordDenial(FIRST_TURN)

      expect([fourth, fifth]).toStrictEqual([
        BreakerDecision.Escalate({ consecutive: 1, total: 4 }),
        BreakerDecision.Escalate({ consecutive: 1, total: 5 }),
      ])
    }).pipe(Effect.provide(breakerLayer)),
  )

  it.effect("does not let late approvals erase another turn's denials", () =>
    Effect.gen(function* lateApproval() {
      const breaker = yield* DenialBreaker

      yield* breaker.recordDenial(FIRST_TURN)
      yield* breaker.recordDenial(SECOND_TURN)
      yield* breaker.recordDenial(SECOND_TURN)
      yield* breaker.recordApproval(FIRST_TURN)
      const current = yield* breaker.recordDenial(SECOND_TURN)
      const previous = yield* breaker.recordDenial(FIRST_TURN)

      expect([current, previous]).toStrictEqual([
        BreakerDecision.Escalate({ consecutive: 3, total: 3 }),
        BreakerDecision.Deny({ consecutive: 1, total: 2 }),
      ])
    }).pipe(Effect.provide(breakerLayer)),
  )
})

describe("denial breaker concurrency", () => {
  it.effect("counts concurrent denials without losing updates", () =>
    Effect.gen(function* concurrentDenials() {
      const breaker = yield* DenialBreaker

      const decisions = yield* Effect.all(
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
    }).pipe(Effect.provide(breakerLayer)),
  )
})
