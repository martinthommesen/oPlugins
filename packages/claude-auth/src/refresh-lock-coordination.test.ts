import { Effect, FileSystem } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedStderr from "./captured-stderr.test-support.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import type { Vitest } from "@effect/vitest"
import support from "./refresh-lock.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

const COOLDOWN_MS = 30_000,
  COOLDOWN_OVER = 31_000,
  FIVE_ASSERTIONS = 5,
  IN_COOLDOWN = 5000,
  LIVE_FOR_MS = 60_000,
  NOW = 0,
  ONE_ASSERTION = 1,
  ONE_LINE = 1,
  ONE_TICKET = 1,
  SHORT_TTL_MS = 1000,
  THREE_ASSERTIONS = 3,
  TTL_MS = 20_000,
  TWO_ASSERTIONS = 2,
  TWO_TICKETS = 2,
  /*
   * Take the lock in `dir`, defer it into a cooldown and release it, then
   * ask for it again with `ttlMs` while the cooldown runs.
   */
  retakenInCooldown = Effect.fn("test.retakenInCooldown")(
    function* retakenInCooldown(dir: string, ttlMs: number) {
      const lock = yield* support.held(
        yield* support.takeLock(dir, SHORT_TTL_MS, NOW),
      )

      return yield* lock
        .defer(COOLDOWN_MS)
        .pipe(
          Effect.andThen(lock.release),
          Effect.andThen(support.takeLock(dir, ttlMs, IN_COOLDOWN)),
        )
    },
  )

describe("refresh lock cooldowns", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("preserves a deferred cooldown claim after release", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const dir = yield* support.sandbox,
          pending = yield* retakenInCooldown(dir, SHORT_TTL_MS),
          resumed = yield* support.takeLock(dir, SHORT_TTL_MS, COOLDOWN_OVER)

        expect(support.isHeld(pending)).toBe(false)
        expect(support.isHeld(resumed)).toBe(true)
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect(
      "reports a deferred claim as a cooldown that ends with its lease",
      () =>
        Effect.gen(function* run() {
          expect.assertions(ONE_ASSERTION)

          const dir = yield* support.sandbox,
            pending = yield* retakenInCooldown(dir, TTL_MS)

          /*
           * Nobody is refreshing, so a caller should not wait for a result that
           * will not come: it is told how long the cooldown has left instead.
           */
          expect(pending).toStrictEqual(
            LockAttempt.cooldown({ until: support.base + COOLDOWN_MS }),
          )
        }),
    )
  })
})

test.layer(support.layer)("refresh lock sources", (it: Tests) => {
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
    }),
  )
})

test.layer(support.layer)("refresh lock tombstones", (it: Tests) => {
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
    }),
  )
})

test.layer(support.layer)("refresh lock stray files", (it: Tests) => {
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
    }),
  )
})

test.layer(support.layer)("refresh lock degradation", (it: Tests) => {
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
      }),
  )
})
