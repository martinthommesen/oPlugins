import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import { Effect } from "effect"
import type { Vitest } from "@effect/vitest"
import faults from "./refresh-lock-faults.test-support.ts"
import support from "./refresh-lock.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

const COOLDOWN_MS = 60_000,
  EXTENDED_MS = 45_000,
  FIRST_TICKET = 1,
  /** Past the reader's lease, but within the cooldown the ticket holds. */
  IN_COOLDOWN = 50_000,
  /** Past the reader's lease, but within the lease the ticket holds. */
  IN_LEASE = 30_000,
  LONG_TTL_MS = 100_000,
  NOW = 0,
  /** Past the longest lease oc-auth writes. */
  PAST_LONGEST = 121_000,
  TTL_MS = 20_000,
  /*
   * Ask for the lock at `offset`, as a reader that can't read ticket 1 in
   * `dir`, last changed at the base time.
   */
  unreadableAt = Effect.fn("test.unreadableAt")(function* unreadableAt(
    dir: string,
    offset: number,
  ) {
    const first = yield* support.ticketPath(dir, FIRST_TICKET)

    yield* faults.changedAt(first, NOW)
    yield* support.at(offset)

    return yield* faults.takeFaulty(dir, faults.unreadable([first]))
  })

describe("refresh lock tickets that can't be read", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("keeps an unreadable extended lease live", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          holder = yield* support.held(
            yield* support.takeLock(dir, TTL_MS, NOW),
          ),
          renewed = yield* holder.extend(EXTENDED_MS),
          rival = yield* unreadableAt(dir, IN_LEASE)

        expect(renewed).toBe(true)
        expect(support.isHeld(rival)).toBe(false)
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("keeps an unreadable cooldown lease live", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          holder = yield* support.held(
            yield* support.takeLock(dir, TTL_MS, NOW),
          ),
          rival = yield* holder
            .defer(COOLDOWN_MS)
            .pipe(
              Effect.andThen(holder.release),
              Effect.andThen(unreadableAt(dir, IN_COOLDOWN)),
            )

        expect(support.isHeld(rival)).toBe(false)
      }),
    )
  })
})

describe("refresh lock tickets that can't be read, by lease length", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect(
      "keeps an unreadable lease from a process with a longer lease live",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const dir = yield* support.sandbox,
            holder = yield* support.takeLock(dir, LONG_TTL_MS, NOW),
            rival = yield* unreadableAt(dir, IN_COOLDOWN)

          expect(support.isHeld(holder)).toBe(true)
          expect(support.isHeld(rival)).toBe(false)
        }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("lets an unreadable lease end after the longest lease", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          holder = yield* support.held(
            yield* support.takeLock(dir, TTL_MS, NOW),
          ),
          renewed = yield* holder.extend(EXTENDED_MS),
          rival = yield* unreadableAt(dir, PAST_LONGEST)

        expect(renewed).toBe(true)
        expect(support.isHeld(rival)).toBe(true)
      }),
    )
  })
})

test.layer(support.layer)(
  "refresh lock tickets that can't be examined",
  (it: Tests) => {
    it.effect("degrades with a warning rather than ignore the ticket", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const dir = yield* support.sandbox,
          first = yield* support.ticketPath(dir, FIRST_TICKET),
          holder = yield* support.takeLock(dir, TTL_MS, NOW),
          logs = yield* CapturedLogs,
          rival = yield* support.held(
            yield* faults.takeFaulty(dir, faults.unexaminable([first])),
          ),
          warned = yield* logs.named("refresh_lock_degraded")

        expect(support.isHeld(holder)).toBe(true)
        expect(rival.degraded).toBe(true)
        // The warning names the store without its path.
        expect(
          warned
            .filter((record) => record.level === "Warn")
            .map((record) => record.annotations),
        ).toStrictEqual([{ lock: support.lock }])
      }),
    )
  },
)
