import { Effect, FileSystem } from "effect"
import { describe, expect, it } from "@effect/vitest"
import CapturedStderr from "./captured-stderr.test-support.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import support from "./refresh-lock.test-support.ts"

const ALWAYS = Effect.succeed(true),
  COOLDOWN_MS = 30_000,
  COOLDOWN_OVER = 31_000,
  EARLIER_TICKET = 5,
  FIVE_ASSERTIONS = 5,
  IN_COOLDOWN = 5000,
  LATER_TICKET = 2,
  LIVE_FOR_MS = 60_000,
  NOW = 0,
  ONE_ASSERTION = 1,
  ONE_LINE = 1,
  ONE_TICKET = 1,
  OWN_TICKET = 1,
  RACED_TICKET = 6,
  RELEASED = 0,
  SHORT_TTL_MS = 1000,
  THREE_ASSERTIONS = 3,
  TTL_MS = 20_000,
  TWO_ASSERTIONS = 2,
  TWO_TICKETS = 2

describe("refresh lock cooldowns", () => {
  it.effect("preserves a deferred cooldown claim after release", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const dir = yield* support.sandbox,
        lock = yield* support.held(
          yield* support.takeLock(dir, SHORT_TTL_MS, NOW),
        ),
        pending = yield* lock
          .defer(COOLDOWN_MS)
          .pipe(
            Effect.andThen(lock.release),
            Effect.andThen(support.takeLock(dir, SHORT_TTL_MS, IN_COOLDOWN)),
          ),
        resumed = yield* support.takeLock(dir, SHORT_TTL_MS, COOLDOWN_OVER)

      expect(support.isHeld(pending)).toBe(false)
      expect(support.isHeld(resumed)).toBe(true)
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect(
    "reports a deferred claim as a cooldown that ends with its lease",
    () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const dir = yield* support.sandbox,
          lock = yield* support.held(
            yield* support.takeLock(dir, SHORT_TTL_MS, NOW),
          ),
          pending = yield* lock
            .defer(COOLDOWN_MS)
            .pipe(
              Effect.andThen(lock.release),
              Effect.andThen(support.takeLock(dir, TTL_MS, IN_COOLDOWN)),
            )

        /*
         * Nobody is refreshing, so a caller should not wait for a result that
         * will not come: it is told how long the cooldown has left instead.
         */
        expect(pending).toStrictEqual(
          LockAttempt.cooldown({ until: support.base + COOLDOWN_MS }),
        )
      }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock sources", () => {
  it.effect("keeps locks for different sources independent", () =>
    Effect.gen(function* run() {
      expect.assertions(FIVE_ASSERTIONS)

      const dir = yield* support.sandbox,
        first = yield* support.takeSource(dir, "source-a"),
        fs = yield* FileSystem.FileSystem,
        second = yield* support.takeSource(dir, "source-b"),
        tickets = yield* fs.readDirectory(dir)

      expect(support.isHeld(first)).toBe(true)
      expect(support.isHeld(second)).toBe(true)
      expect((yield* support.held(first)).degraded).toBe(false)
      expect((yield* support.held(second)).degraded).toBe(false)
      // Each source holds its own ticket.
      expect(tickets.filter((file) => file.endsWith(".lock"))).toHaveLength(
        TWO_TICKETS,
      )
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock tombstones", () => {
  it.effect("keeps an expired ticket until a successor commits", () =>
    Effect.gen(function* run() {
      expect.assertions(FIVE_ASSERTIONS)

      const dir = yield* support.sandbox,
        fs = yield* FileSystem.FileSystem,
        lock = yield* support.held(yield* support.takeLock(dir, TTL_MS, NOW)),
        open = yield* fs.readDirectory(dir),
        released = yield* lock.release.pipe(
          Effect.andThen(fs.readDirectory(dir)),
        ),
        successor = yield* support.held(
          yield* support.takeLock(dir, TTL_MS, NOW),
        ),
        tickets = yield* fs.readDirectory(dir)

      expect(open).toHaveLength(ONE_TICKET)
      // Release leaves an ordering tombstone.
      expect(released.some((file) => file.endsWith(".lock"))).toBe(true)
      expect(successor.degraded).toBe(false)
      expect(tickets).toHaveLength(ONE_TICKET)
      expect(tickets).not.toStrictEqual(released)
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock stray files", () => {
  it.effect("ignores lock files whose ticket is not a number", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const dir = yield* support.sandbox,
        fs = yield* FileSystem.FileSystem,
        strays = [
          `${support.prefix}abc.lock`,
          `${support.prefix}1x.lock`,
          `${support.prefix}.lock`,
        ],
        taken = yield* support
          .writeStrays(dir, strays, support.base + LIVE_FOR_MS)
          .pipe(Effect.andThen(support.takeLock(dir, TTL_MS, NOW))),
        tickets = yield* fs.readDirectory(dir)

      /*
       * A non-numeric name reaching BigInt() throws inside the scan, which
       * would produce a degraded lock that serializes nothing.
       */
      expect(support.isHeld(taken)).toBe(true)
      expect((yield* support.held(taken)).degraded).toBe(false)
      // The stray files are left alone and the first ticket is 1.
      expect(tickets.toSorted()).toStrictEqual(
        [...strays, `${support.prefix}1.lock`].toSorted(),
      )
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock degradation", () => {
  it.effect(
    "degrades to a marked no-op lock when the lock dir is unusable",
    () =>
      Effect.gen(function* run() {
        expect.assertions(FIVE_ASSERTIONS)

        /*
         * Point at a path whose parent is a file, so mkdir/open cannot create
         * the lock. The lock must never block a refresh, so it grants a no-op.
         */
        const dir = yield* support.sandbox,
          fs = yield* FileSystem.FileSystem,
          lockDir = yield* support.blockedDir(dir),
          pair = yield* support.requestTwice(lockDir),
          stderr = yield* CapturedStderr

        /*
         * Uncoordinated refreshes can burn the shared refresh token, so the
         * user hears about it even with the debug log off.
         */
        expect((yield* stderr.text).trim().split("\n")).toHaveLength(ONE_LINE)
        expect(yield* stderr.text).toMatch(/not coordinated/u)
        /*
         * Without this the degraded lock is indistinguishable from a real one,
         * and a caller cannot tell that nothing is being serialized.
         */
        expect((yield* support.held(pair.first)).degraded).toBe(true)
        // Degradation grants every caller at once.
        expect((yield* support.held(pair.second)).degraded).toBe(true)
        // The parent is a file, so asking whether it exists is itself an error.
        expect(
          yield* fs.exists(lockDir).pipe(Effect.orElseSucceed(() => false)),
        ).toBe(false)
      }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock races for the next ticket", () => {
  it.effect(
    "backs off when a live claim appears while racing for the next ticket",
    () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        /*
         * The first clock read follows the initial scan and precedes the
         * exclusive create of ticket 6, so this is the race window.
         */
        const dir = yield* support.sandbox,
          fs = yield* FileSystem.FileSystem,
          inject = support.writeTicket(
            dir,
            RACED_TICKET,
            support.base + LIVE_FOR_MS,
          ),
          race = yield* support
            .writeTicket(dir, EARLIER_TICKET, RELEASED)
            .pipe(Effect.andThen(support.withInjection(dir, ALWAYS, inject))),
          tickets = yield* fs.readDirectory(dir)

        /*
         * Without the EEXIST rescan this either throws into a degraded lock or
         * takes ticket 7 over a live holder, and two processes refresh at once.
         */
        expect(support.isHeld(race.attempt)).toBe(false)
        expect(tickets.toSorted()).toStrictEqual([
          `${support.prefix}5.lock`,
          `${support.prefix}6.lock`,
        ])
      }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock races past expired tickets", () => {
  it.effect("skips past a ticket that was taken but is already expired", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const dir = yield* support.sandbox,
        fs = yield* FileSystem.FileSystem,
        inject = support.writeTicket(dir, RACED_TICKET, RELEASED),
        race = yield* support
          .writeTicket(dir, EARLIER_TICKET, RELEASED)
          .pipe(Effect.andThen(support.withInjection(dir, ALWAYS, inject))),
        tickets = yield* fs.readDirectory(dir)

      // An expired claim does not block the retry.
      expect(support.isHeld(race.attempt)).toBe(true)
      expect((yield* support.held(race.attempt)).degraded).toBe(false)
      /*
       * Ticket 6 was lost to the race, so the claim lands on 7, and the
       * commit sweep then removes the expired tombstones below it.
       */
      expect(tickets).toStrictEqual([`${support.prefix}7.lock`])
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("refresh lock races after creating a ticket", () => {
  it.effect(
    "withdraws a claim when a later ticket is committed meanwhile",
    () =>
      Effect.gen(function* run() {
        expect.assertions(FIVE_ASSERTIONS)

        /*
         * The first clock read after this caller's ticket exists is the lease
         * write, which precedes the post-commit supersession scan.
         */
        const dir = yield* support.sandbox,
          fs = yield* FileSystem.FileSystem,
          own = yield* support.ticketPath(dir, OWN_TICKET),
          race = yield* support.withInjection(
            dir,
            fs.exists(own),
            support.writeTicket(dir, LATER_TICKET, support.base + LIVE_FOR_MS),
          ),
          released = yield* support.leaseExpiry(own),
          // Once the winner is done, the loser's leftover must not hold anyone up.
          successor = yield* support
            .writeTicket(dir, LATER_TICKET, RELEASED)
            .pipe(Effect.andThen(support.takeLock(dir, TTL_MS, NOW))),
          tickets = yield* fs.readDirectory(dir)

        // A higher committed ticket wins.
        expect(support.isHeld(race.attempt)).toBe(false)
        // The later ticket really appeared after our create.
        expect(race.injected).toBe(true)
        // The withdrawn claim is expired so it blocks nobody.
        expect(released).toBe(RELEASED)
        // A withdrawn ticket leaves no live claim behind.
        expect((yield* support.held(successor)).degraded).toBe(false)
        expect(tickets).toStrictEqual([`${support.prefix}3.lock`])
      }).pipe(Effect.provide(support.layer)),
  )
})
