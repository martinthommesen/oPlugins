import { Effect, Fiber, Option, Ref } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Vitest } from "@effect/vitest"
import faults from "./refresh-lock-faults.test-support.ts"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import support from "./credential-refresh.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<ReturnType<typeof refreshLayer>>> | Scope.Scope
  >
}

type Script = typeof support.script

type Refresh = Effect.Success<ReturnType<typeof support.refresh>>

type Asked = Readonly<Parameters<typeof support.refresh>[typeof FIRST]>

const COOLDOWN_MS = 20_000,
  /** The lease write that extends the lock: the first one publishes it. */
  EXTENSION_WRITE = 2,
  FIRST = 0,
  NO_BYTES = 0,
  NO_EXCHANGES = 0,
  ONE_EXCHANGE = 1,
  /* Each refresh's access token, for comparing outcomes. */
  accessOf = (results: readonly Refresh[]): Option.Option<string>[] =>
    results.map((result) => support.summary(result).access),
  /* Two refreshes of `credential` at once, released together. */
  concurrently = Effect.fn("test.concurrently")(function* concurrently(
    credential: Asked,
  ) {
    const both = yield* Effect.forkChild(
      Effect.all([support.refresh(credential), support.refresh(credential)], {
        concurrency: "unbounded",
      }),
    )

    yield* support.settle
    yield* support.currentRig.pipe(Effect.flatMap((rig) => rig.gate.open))

    return yield* Fiber.join(both)
  }),
  /* The refresh tokens the rig's endpoint has seen, in order. */
  exchangesSoFar = support.currentRig.pipe(
    Effect.flatMap((rig) => Ref.get(rig.exchanged)),
  ),
  /* What the store holds before anything rotates. */
  fixtureTokens = Option.some(support.account().credentials),
  /* A rig whose endpoint waits for the gate before answering. */
  gatedScript: Script = Object.freeze({
    acquire: support.script.acquire,
    exchange: (refreshToken: string) =>
      support.currentRig.pipe(
        Effect.flatMap((rig) => rig.gate.await),
        Effect.andThen(support.script.exchange(refreshToken)),
      ),
    read: support.script.read,
    writeBack: support.script.writeBack,
  }),
  gatedStore = refreshLayer(gatedScript)(fixtureTokens),
  holderTokens = Option.some(support.tokens("holder-access", "holder-refresh")),
  /*
   * A refresh that loses its lease, during which the lock holder writes its
   * own credential into the store.
   */
  holderWritesDuring = Effect.fn("test.holderWritesDuring")(
    function* holderWritesDuring(credential: Asked) {
      const pending = yield* Effect.forkChild(support.refresh(credential))

      yield* support.settle
      yield* support.currentRig.pipe(
        Effect.flatMap((rig) => Ref.set(rig.stored, holderTokens)),
      )

      return yield* support.polled(Fiber.join(pending))
    },
  ),
  /* A healthy rig whose lock answers `acquire` instead. */
  lockedBy = (acquire: Script["acquire"]): Script =>
    Object.freeze({
      acquire,
      exchange: support.script.exchange,
      read: support.script.read,
      writeBack: support.script.writeBack,
    }),
  lostLease = refreshLayer(lockedBy(support.heldLock(false)))(fixtureTokens),
  /* What the store holds after Claude Code rotated it. */
  newerTokens = Option.some(support.tokens("rotated-access")),
  /* An extension write that fails, as the lock holder writes its credential into the store. */
  onFaultHolderWrites = (
    rig: Effect.Success<typeof support.currentRig>,
  ): Parameters<typeof faults.takeFaultyAnywhere>[typeof FIRST] =>
    faults.failWrite(
      EXTENSION_WRITE,
      NO_BYTES,
      Ref.set(rig.stored, holderTokens),
    ),
  original = support.imported(support.account()),
  otherBusy = refreshLayer(lockedBy(support.busy))(fixtureTokens),
  otherCooling = lockedBy(
    support.cooldownUntil(support.BASE_TIME + COOLDOWN_MS),
  ),
  otherCoolingOld = refreshLayer(otherCooling)(fixtureTokens),
  otherCoolingRotated = refreshLayer(otherCooling)(newerTokens),
  /* A real lock whose extension can't be written. */
  realLockUnextended: Script["acquire"] = support.currentRig.pipe(
    Effect.flatMap((rig) =>
      faults.takeFaultyAnywhere(onFaultHolderWrites(rig)),
    ),
  ),
  unwrittenExtension = refreshLayer(lockedBy(realLockUnextended))(fixtureTokens)

test.layer(lostLease)("refresh after losing the lease", (it: Tests) => {
  it.effect(
    "waits for the lock holder's credential when the lease is lost",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const refreshed = yield* holderWritesDuring(yield* original)

        expect(support.summary(refreshed).access).toStrictEqual(
          Option.some("holder-access"),
        )
        // It must not spend a refresh token it cannot hold.
        expect(yield* exchangesSoFar).toHaveLength(NO_EXCHANGES)
      }),
  )
})

test.layer(unwrittenExtension)(
  "refresh after failing to extend the lease",
  (it: Tests) => {
    it.effect(
      "waits for the lock holder's credential when the extension isn't written",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const refreshed = yield* support.refresh(yield* original),
            reported = yield* (yield* CapturedLogs).named(
              "refresh_lease_unwritten",
            )

          expect(support.summary(refreshed).access).toStrictEqual(
            Option.some("holder-access"),
          )
          // It must not spend a refresh token its lease doesn't cover.
          expect(yield* exchangesSoFar).toHaveLength(NO_EXCHANGES)
          expect(reported.map((record) => record.level)).toContain("Warn")
        }),
    )
  },
)

test.layer(otherBusy)(
  "refresh while another process holds the lock",
  (it: Tests) => {
    it.effect(
      "reports transient when no external credential arrives before the deadline",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const refreshed = yield* support.polled(
            support.refresh(yield* original),
          )

          expect(support.summary(refreshed).kind).toBe("transient")
          expect(yield* exchangesSoFar).toHaveLength(NO_EXCHANGES)
        }),
    )
  },
)

describe("refresh while another process cools down", () => {
  test.layer(otherCoolingOld)((it: Tests) => {
    it.effect(
      "returns at once with the cooldown another process is waiting out",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          /*
           * Nobody is refreshing, so polling for their result would only add
           * latency: this finishes with no clock advance.
           */
          const refreshed = yield* support.refresh(yield* original)

          expect(support.summary(refreshed)).toStrictEqual({
            access: Option.none(),
            kind: "transient",
            retryAfterMs: Option.some(COOLDOWN_MS),
          })
        }),
    )
  })

  /*
   * 401 recovery calls refresh first and relies on it to adopt a credential
   * rotated outside OpenCode before any cooldown can turn it away.
   */
  test.layer(otherCoolingRotated)((it: Tests) => {
    it.effect(
      "adopts a rotated credential even while another process is cooling down",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const refreshed = yield* support.refresh(yield* original)

          expect(support.summary(refreshed).access).toStrictEqual(
            Option.some("rotated-access"),
          )
          expect(yield* exchangesSoFar).toHaveLength(NO_EXCHANGES)
        }),
    )
  })
})

test.layer(gatedStore)(
  "concurrent refreshes of one credential",
  (it: Tests) => {
    it.effect("shares one exchange between concurrent refreshes", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const results = yield* concurrently(yield* original)

        expect(yield* exchangesSoFar).toHaveLength(ONE_EXCHANGE)
        expect(accessOf(results)).toStrictEqual([
          Option.some("new-access"),
          Option.some("new-access"),
        ])
      }),
    )
  },
)
