import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import { Effect } from "effect"
import LockAttempt from "./refresh-lock-attempt.ts"
import type { Vitest } from "@effect/vitest"
import faults from "./refresh-lock-faults.test-support.ts"
import support from "./refresh-lock.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

const COOLDOWN_MS = 30_000,
  EXTENDED_MS = 45_000,
  FIRST_TICKET = 1,
  IN_COOLDOWN = 5000,
  NOTHING = 0,
  NOW = 0,
  /*
   * Bytes of a lease that land before its write fails. They end inside the
   * expiry, so the mix of new and old bytes still decodes, as a lease that is
   * neither the old one nor the new one.
   */
  PARTIAL = 30,
  PUBLICATION = 1,
  RELEASED = 0,
  SECOND_WRITE = 2,
  TTL_MS = 20_000,
  /*
   * Take the lock in `dir` with ticket write `failing` failing after
   * `partial` bytes, defer it into a cooldown, release it, and ask again.
   */
  retakenAfterDeferral = Effect.fn("test.retakenAfterDeferral")(
    function* retakenAfterDeferral(dir: string, partial: number) {
      const lock = yield* support.held(
        yield* faults.takeFaulty(dir, faults.failWrite(SECOND_WRITE, partial)),
      )

      return yield* lock
        .defer(COOLDOWN_MS)
        .pipe(
          Effect.andThen(lock.release),
          Effect.andThen(support.takeLock(dir, TTL_MS, IN_COOLDOWN)),
        )
    },
  ),
  /* Take the lock in `dir` with its first lease failing after `partial` bytes. */
  unpublished = Effect.fn("test.unpublished")(function* unpublished(
    dir: string,
    partial: number,
  ) {
    return yield* faults.takeFaulty(dir, faults.failWrite(PUBLICATION, partial))
  })

describe("refresh lock publication that fails", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("withdraws a ticket whose first lease isn't written", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          outcome = yield* unpublished(dir, NOTHING),
          released = yield* support.leaseExpiry(
            yield* support.ticketPath(dir, FIRST_TICKET),
          ),
          successor = yield* support.takeLock(dir, TTL_MS, NOW)

        expect(outcome).toStrictEqual(LockAttempt.Busy())
        // The withdrawn ticket blocks nobody.
        expect(released).toBe(RELEASED)
        expect(support.isHeld(successor)).toBe(true)
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("withdraws a ticket whose first lease is partly written", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          outcome = yield* unpublished(dir, PARTIAL),
          successor = yield* support.takeLock(dir, TTL_MS, NOW)

        expect(outcome).toStrictEqual(LockAttempt.Busy())
        expect(support.isHeld(successor)).toBe(true)
      }),
    )
  })
})

describe("refresh lock extension that fails", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("reports an extension it couldn't write as lost", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          lock = yield* support.held(
            yield* faults.takeFaulty(
              dir,
              faults.failWrite(SECOND_WRITE, NOTHING),
            ),
          ),
          renewed = yield* lock.extend(EXTENDED_MS)

        expect(lock.degraded).toBe(false)
        expect(renewed).toBe(false)
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("reports an extension it wrote only partly as lost", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          lock = yield* support.held(
            yield* faults.takeFaulty(
              dir,
              faults.failWrite(SECOND_WRITE, PARTIAL),
            ),
          ),
          renewed = yield* lock.extend(EXTENDED_MS),
          successor = yield* lock.release.pipe(
            Effect.andThen(support.takeLock(dir, TTL_MS, NOW)),
          )

        expect(renewed).toBe(false)
        // Release rewrites the whole lease, whatever the failed write left.
        expect(support.isHeld(successor)).toBe(true)
      }),
    )
  })
})

describe("refresh lock deferral that fails", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("releases as usual after a cooldown lease isn't written", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          retaken = yield* retakenAfterDeferral(dir, NOTHING)

        expect(support.isHeld(retaken)).toBe(true)
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect(
      "releases as usual after a cooldown lease is partly written",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const dir = yield* support.sandbox,
            retaken = yield* retakenAfterDeferral(dir, PARTIAL)

          // The partial write decoded as a cooldown; release must not keep it.
          expect(support.isHeld(retaken)).toBe(true)
        }),
    )
  })
})

test.layer(support.layer)("refresh lock write failure logs", (it: Tests) => {
  it.effect("warns about a failed lease write with metadata only", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const dir = yield* support.sandbox,
        lock = yield* support.held(
          yield* faults.takeFaulty(
            dir,
            faults.failWrite(SECOND_WRITE, NOTHING),
          ),
        ),
        logs = yield* CapturedLogs,
        renewed = yield* lock.extend(EXTENDED_MS),
        reported = yield* logs.named("refresh_lease_unwritten")

      expect(renewed).toBe(false)
      // The warning names the store without its path; the debug record adds the cause.
      expect(
        reported.map((record) => [
          record.level,
          Object.keys(record.annotations).toSorted(),
        ]),
      ).toStrictEqual([
        ["Warn", ["lease", "lock"]],
        ["Debug", ["error", "lease", "source"]],
      ])
      expect(
        reported
          .filter((record) => record.level === "Warn")
          .map((record) => record.annotations),
      ).toStrictEqual([{ lease: "extension", lock: support.lock }])
    }),
  )
})
