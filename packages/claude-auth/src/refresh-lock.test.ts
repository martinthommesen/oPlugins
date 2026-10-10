import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import LockAttempt from "./refresh-lock-attempt.ts"
import RefreshLock from "./refresh-lock.ts"
import support from "./refresh-lock.test-support.ts"

const CAP_MARGIN_MS = 1000,
  EXTENDED_MS = 30_000,
  LIVE_FOR_MS = 60_000,
  LONG_TTL_MS = 60_000,
  MEDIUM_TTL_MS = 10_000,
  // Ten hours: a TTL nobody meant.
  MISTYPED_TTL_MS = 36_000_000,
  NOW = 0,
  ONE_ASSERTION = 1,
  PAST_CAP = RefreshLock.maxTtlMs + CAP_MARGIN_MS,
  PAST_SHORT_TTL = 2000,
  SHORT_TTL_MS = 1000,
  SOON = 1000,
  STALE_AT = 60_000,
  THREE_ASSERTIONS = 3,
  TTL_MS = 20_000,
  TWO_ASSERTIONS = 2,
  WELL_PAST_TTL = 5000

describe("refresh lock holders", () => {
  it.effect(
    "grants the lock to the first caller and denies a second holder",
    () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const dir = yield* support.sandbox,
          first = yield* support.takeLock(dir, TTL_MS, NOW),
          second = yield* support.takeLock(dir, TTL_MS, NOW)

        expect(support.isHeld(first)).toBe(true)
        expect(support.isHeld(second)).toBe(false)
      }).pipe(Effect.provide(support.layer)),
  )

  it.effect("releases the lock so a later caller can acquire it", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const dir = yield* support.sandbox,
        first = yield* support.held(yield* support.takeLock(dir, TTL_MS, NOW)),
        second = yield* first.release.pipe(
          Effect.andThen(support.takeLock(dir, TTL_MS, NOW)),
        )

      expect(first.degraded).toBe(false)
      expect(support.isHeld(second)).toBe(true)
      expect((yield* support.held(second)).degraded).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock contention", () => {
  it.effect("reports a claim another process is refreshing under as busy", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const dir = yield* support.sandbox,
        first = yield* support.takeLock(dir, TTL_MS, NOW),
        second = yield* support.takeLock(dir, TTL_MS, NOW)

      expect(support.isHeld(first)).toBe(true)
      expect(second).toStrictEqual(LockAttempt.busy())
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("does not take over a lock that is still within its TTL", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const dir = yield* support.sandbox,
        holder = yield* support.takeLock(dir, LONG_TTL_MS, NOW),
        rival = yield* support.takeLock(dir, LONG_TTL_MS, SOON)

      expect(support.isHeld(holder)).toBe(true)
      expect(support.isHeld(rival)).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock expiry", () => {
  it.effect("takes over a stale lock past its TTL", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      /*
       * The holder "crashes" without releasing; the lock file lingers. A later
       * acquirer looking from far enough in the future treats it as stale.
       */
      const dir = yield* support.sandbox,
        holder = yield* support.takeLock(dir, TTL_MS, NOW),
        takeover = yield* support.takeLock(dir, TTL_MS, STALE_AT)

      expect(support.isHeld(holder)).toBe(true)
      expect(support.isHeld(takeover)).toBe(true)
      expect((yield* support.held(takeover)).degraded).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect(
    "caps a lease so a mistyped TTL cannot block refreshes for days",
    () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const dir = yield* support.sandbox,
          lock = yield* support.takeLock(dir, MISTYPED_TTL_MS, NOW),
          successor = yield* support.takeLock(dir, TTL_MS, PAST_CAP)

        expect(support.isHeld(lock)).toBe(true)
        // The capped lease expires and a successor takes over.
        expect(support.isHeld(successor)).toBe(true)
      }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock unreadable claims", () => {
  it.effect("treats a temporarily unreadable fresh claim as live", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const dir = yield* support.sandbox,
        lock = yield* support.takeLock(dir, LONG_TTL_MS, NOW),
        rival = yield* support
          .blankTickets(dir)
          .pipe(Effect.andThen(support.takeLock(dir, LONG_TTL_MS, NOW)))

      expect(support.isHeld(lock)).toBe(true)
      expect(support.isHeld(rival)).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock leases", () => {
  it.effect("does not let a stale holder release its successor's lock", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const dir = yield* support.sandbox,
        first = yield* support.held(
          yield* support.takeLock(dir, SHORT_TTL_MS, NOW),
        ),
        second = yield* support.takeLock(dir, MEDIUM_TTL_MS, PAST_SHORT_TTL),
        stale = yield* first.extend(EXTENDED_MS),
        third = yield* first.release.pipe(
          Effect.andThen(support.takeLock(dir, MEDIUM_TTL_MS, PAST_SHORT_TTL)),
        )

      expect(support.isHeld(second)).toBe(true)
      expect(stale).toBe(false)
      expect(support.isHeld(third)).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("extends the lease for a refresh longer than the base TTL", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const dir = yield* support.sandbox,
        lock = yield* support.held(
          yield* support.takeLock(dir, SHORT_TTL_MS, NOW),
        ),
        renewed = yield* lock.extend(EXTENDED_MS),
        rival = yield* support.takeLock(dir, SHORT_TTL_MS, WELL_PAST_TTL)

      expect(renewed).toBe(true)
      expect(support.isHeld(rival)).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock lease ownership", () => {
  it.effect("does not renew an owner after its lease expires", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const dir = yield* support.sandbox,
        lock = yield* support.held(
          yield* support.takeLock(dir, SHORT_TTL_MS, NOW),
        ),
        renewed = yield* support
          .at(PAST_SHORT_TTL)
          .pipe(Effect.andThen(lock.extend(EXTENDED_MS)))

      expect(renewed).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("will not revive a lease it no longer owns", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      // The stale holder tries to keep its claim alive on the way out.
      const dir = yield* support.sandbox,
        first = yield* support.held(yield* support.takeLock(dir, TTL_MS, NOW)),
        successor = yield* support.takeLock(dir, TTL_MS, STALE_AT),
        taken = yield* first
          .defer(LIVE_FOR_MS)
          .pipe(Effect.andThen(support.takeLock(dir, TTL_MS, STALE_AT)))

      // The stale claim is superseded, and the successor still holds the lock.
      expect(support.isHeld(successor)).toBe(true)
      expect(support.isHeld(taken)).toBe(false)
    }).pipe(Effect.provide(support.layer)),
  )
})
