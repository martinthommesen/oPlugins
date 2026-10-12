import { Effect, FileSystem } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Vitest } from "@effect/vitest"
import faults from "./refresh-lock-faults.test-support.ts"
import support from "./refresh-lock.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

/** Ten days: further off than any lease oc-auth writes. */
const FAR_OFF_MS = 864_000_000,
  FIRST_TICKET = 1,
  /** Past the reader's lease, but within the longest lease. */
  IN_LONGEST = 30_000,
  LONGEST_MS = 120_000,
  NOW = 0,
  /** The start of a lease whose write stopped partway. */
  PARTIAL_LEASE = '{"cooldown":false,"expiresAt":10',
  /** Past the longest lease oc-auth writes. */
  PAST_LONGEST = 121_000,
  TTL_MS = 20_000,
  /*
   * Write `text` as ticket 1 in `dir`, last changed at the base time, and
   * ask for the lock at `offset`.
   */
  takeAfter = Effect.fn("test.takeAfter")(function* takeAfter(
    dir: string,
    text: string,
    offset: number,
  ) {
    const first = yield* support.ticketPath(dir, FIRST_TICKET),
      fs = yield* FileSystem.FileSystem

    yield* fs.writeFileString(first, text)
    yield* faults.changedAt(first, NOW)

    return yield* support.takeLock(dir, TTL_MS, offset)
  })

describe("refresh lock tickets with a broken lease", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("keeps a partly written lease live for the longest lease", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          rival = yield* takeAfter(dir, PARTIAL_LEASE, IN_LONGEST)

        // A partial lease is not mistaken for a new, empty ticket.
        expect(support.isHeld(rival)).toBe(false)
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("doesn't trust a lease further off than the longest", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          stalled = yield* support
            .writeTicket(dir, FIRST_TICKET, support.base + FAR_OFF_MS)
            .pipe(
              Effect.flatMap((path) => faults.changedAt(path, NOW)),
              Effect.andThen(support.takeLock(dir, TTL_MS, PAST_LONGEST)),
            )

        expect(support.isHeld(stalled)).toBe(true)
      }),
    )
  })
})

test.layer(support.layer)("refresh lock lease lengths", (it: Tests) => {
  it.effect("caps every lease at the longest lease a reader allows for", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const dir = yield* support.sandbox,
        lock = yield* support.held(yield* support.takeLock(dir, TTL_MS, NOW)),
        renewed = yield* lock.extend(FAR_OFF_MS),
        written = yield* support.leaseExpiry(
          yield* support.ticketPath(dir, FIRST_TICKET),
        )

      expect(renewed).toBe(true)
      expect(written).toBe(support.base + LONGEST_MS)
    }),
  )
})

test.layer(support.layer)("refresh lock tickets still empty", (it: Tests) => {
  it.effect("lets a new, empty ticket end with the reader's lease", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const dir = yield* support.sandbox,
        early = yield* takeAfter(dir, "", NOW),
        late = yield* takeAfter(dir, "", IN_LONGEST)

      expect(support.isHeld(early)).toBe(false)
      expect(support.isHeld(late)).toBe(true)
    }),
  )
})

test.layer(support.layer)("refresh lock tickets left behind", (it: Tests) => {
  it.effect("logs an expired ticket it couldn't remove", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      // A directory at the ticket's path can be examined, not read or removed.
      const dir = yield* support.sandbox,
        first = yield* support.ticketPath(dir, FIRST_TICKET),
        fs = yield* FileSystem.FileSystem,
        logs = yield* CapturedLogs,
        taken = yield* fs
          .makeDirectory(first)
          .pipe(
            Effect.andThen(faults.changedAt(first, NOW)),
            Effect.andThen(support.takeLock(dir, TTL_MS, PAST_LONGEST)),
          ),
        unread = yield* logs.named("refresh_lock_ticket_unreadable"),
        unswept = yield* logs.named("refresh_lock_sweep_failed")

      expect(support.isHeld(taken)).toBe(true)
      expect(unread.map((record) => record.level)).toContain("Debug")
      expect(
        unswept.map((record) => [
          record.level,
          Object.keys(record.annotations).toSorted(),
        ]),
      ).toStrictEqual([["Debug", ["error", "path"]]])
    }),
  )
})
