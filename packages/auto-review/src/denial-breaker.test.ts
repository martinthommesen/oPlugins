import { BreakerDecision, DenialBreaker } from "./denial-breaker.ts"
import { Effect, Layer } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { settingsFrom } from "./testing.ts"

const breakerLayer = DenialBreaker.layer.pipe(
  Layer.provide(
    settingsFrom({ maxConsecutiveDenials: "3", maxTotalDenials: "4" }),
  ),
)

describe("denial breaker", () => {
  it.effect("escalates after three consecutive denials", () =>
    Effect.gen(function* consecutive() {
      const breaker = yield* DenialBreaker

      const first = yield* breaker.recordDenial("session", "turn-1")
      const second = yield* breaker.recordDenial("session", "turn-1")
      const third = yield* breaker.recordDenial("session", "turn-1")

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

      yield* breaker.recordDenial("session", "turn-1")
      yield* breaker.recordDenial("session", "turn-1")
      yield* breaker.recordApproval("session", "turn-1")
      const afterApproval = yield* breaker.recordDenial("session", "turn-1")

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

      yield* breaker.recordDenial("session", "turn-1")
      yield* breaker.recordDenial("session", "turn-1")
      yield* breaker.recordApproval("session", "turn-1")
      yield* breaker.recordDenial("session", "turn-1")
      const fourth = yield* breaker.recordDenial("session", "turn-1")

      expect(fourth).toStrictEqual(
        BreakerDecision.Escalate({ consecutive: 2, total: 4 }),
      )
    }).pipe(Effect.provide(breakerLayer)),
  )

  it.effect("counts each turn and session separately", () =>
    Effect.gen(function* separate() {
      const breaker = yield* DenialBreaker

      yield* breaker.recordDenial("session", "turn-1")
      yield* breaker.recordDenial("session", "turn-1")
      const newTurn = yield* breaker.recordDenial("session", "turn-2")
      const otherSession = yield* breaker.recordDenial("other", "turn-1")

      expect([newTurn, otherSession]).toStrictEqual([
        BreakerDecision.Deny({ consecutive: 1, total: 1 }),
        BreakerDecision.Deny({ consecutive: 1, total: 1 }),
      ])
    }).pipe(Effect.provide(breakerLayer)),
  )
})
