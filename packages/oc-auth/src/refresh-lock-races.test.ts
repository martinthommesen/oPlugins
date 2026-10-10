import { Effect, FileSystem } from "effect"
import type { Layer, Scope } from "effect"
import { expect, it as test } from "@effect/vitest"
import type { Vitest } from "@effect/vitest"
import support from "./refresh-lock.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

const ALWAYS = Effect.succeed(true),
  EARLIER_TICKET = 5,
  FIVE_ASSERTIONS = 5,
  LATER_TICKET = 2,
  LIVE_FOR_MS = 60_000,
  NOW = 0,
  OWN_TICKET = 1,
  RACED_TICKET = 6,
  RELEASED = 0,
  THREE_ASSERTIONS = 3,
  TTL_MS = 20_000,
  TWO_ASSERTIONS = 2

test.layer(support.layer)(
  "refresh lock races for the next ticket",
  (it: Tests) => {
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
        }),
    )
  },
)

test.layer(support.layer)(
  "refresh lock races past expired tickets",
  (it: Tests) => {
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
      }),
    )
  },
)

test.layer(support.layer)(
  "refresh lock races after creating a ticket",
  (it: Tests) => {
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
              support.writeTicket(
                dir,
                LATER_TICKET,
                support.base + LIVE_FOR_MS,
              ),
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
        }),
    )
  },
)
