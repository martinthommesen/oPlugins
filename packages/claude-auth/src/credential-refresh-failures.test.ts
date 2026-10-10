import { Array as Arr, Effect, Match, Option, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import ClaudeAuthRefreshExhaustedError from "./claude-auth-refresh-exhausted-error.ts"
import ClaudeCodeStoreError from "./claude-code-store-error.ts"
import { TestClock } from "effect/testing"
import backoffPolicy from "./refresh-backoff-policy.ts"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import support from "./credential-refresh.test-support.ts"

type Script = typeof support.script

type Asked = Readonly<Parameters<typeof support.refresh>[typeof FIRST]>

type Refreshing = ReturnType<typeof support.refresh>

/** A refresh turned around: its error is the value, a success the failure. */
type Flipped = Effect.Effect<
  Effect.Error<Refreshing>,
  Effect.Success<Refreshing> | Effect.Error<Refreshing>,
  Effect.Services<Refreshing>
>

const AFTER_LONGEST_COOLDOWN_MS = 61_000,
  FIRST = 0,
  FIRST_ATTEMPT = 1,
  NO_EXCHANGES = 0,
  ONE_EXCHANGE = 1,
  RETRY_AFTER_MS = 10_000,
  SECOND = 1,
  /* Refresh `credential` `times` times, each after the cooldown has run out. */
  afterCooldowns = (
    credential: Asked,
    times: number,
  ): Effect.Effect<
    string[],
    Effect.Error<ReturnType<typeof support.refresh>>,
    Effect.Services<ReturnType<typeof support.refresh>>
  > =>
    Effect.forEach(Arr.range(FIRST_ATTEMPT, times), () =>
      support.refresh(credential).pipe(
        Effect.map((result) => support.summary(result).kind),
        Effect.tap(() => TestClock.adjust(AFTER_LONGEST_COOLDOWN_MS)),
      ),
    ),
  /* The error refreshing `credential` ends in; a success is the failure. */
  eventualFailure = (credential: Asked): Flipped =>
    Effect.flip(support.refresh(credential)),
  /* The refresh tokens the rig's endpoint has seen, in order. */
  exchangesSoFar = support.currentRig.pipe(
    Effect.flatMap((rig) => Ref.get(rig.exchanged)),
  ),
  /* A healthy rig whose endpoint answers `exchange` instead. */
  exchanging = (exchange: Script["exchange"]): Script =>
    Object.freeze({
      acquire: support.script.acquire,
      exchange,
      read: support.script.read,
      writeBack: support.script.writeBack,
    }),
  /* Refresh `credential` until the ceiling, and the error that ends it. */
  exhaust = (credential: Asked): Flipped =>
    afterCooldowns(
      credential,
      backoffPolicy.MAX_CONSECUTIVE_TRANSIENT - ONE_EXCHANGE,
    ).pipe(Effect.andThen(eventualFailure(credential))),
  fixtureTokens = Option.some(support.account().credentials),
  /* An endpoint rate limiting with `retryAfterMs` as its hint. */
  limitedScript = (retryAfterMs: Option.Option<number>): Script =>
    exchanging(() => support.rateLimited(retryAfterMs)),
  limitedWithHint = refreshLayer(
    limitedScript(Option.some(RETRY_AFTER_MS)),
    fixtureTokens,
  ),
  limitedWithoutHint = refreshLayer(
    limitedScript(Option.none()),
    fixtureTokens,
  ),
  /* A store that cannot be read, as a locked Keychain. */
  lockedKeychain = refreshLayer(
    Object.freeze({
      acquire: support.script.acquire,
      exchange: support.script.exchange,
      read: () =>
        Effect.fail(
          new ClaudeCodeStoreError({ message: "macOS Keychain is locked" }),
        ),
      writeBack: support.script.writeBack,
    }),
    Option.none(),
  ),
  nothingStoredLimited = refreshLayer(
    limitedScript(Option.none()),
    Option.none(),
  ),
  original = support.imported(support.account()),
  otherGeneration = support.imported(
    support.account(support.PRIMARY, "other-generation"),
  ),
  /*
   * An outage of the token endpoint that ends after it has failed the
   * ceiling's worth of times: the results up to the ceiling, the error at it,
   * the exchanges by then, and the result once the outage ends.
   */
  outage = Effect.fn("test.outage")(function* outage(credential: Asked) {
    const attempts = yield* afterCooldowns(
        credential,
        backoffPolicy.MAX_CONSECUTIVE_TRANSIENT - ONE_EXCHANGE,
      ),
      breakdown = yield* Effect.flip(support.refresh(credential)),
      counted = (yield* exchangesSoFar).length,
      recovered = yield* TestClock.adjust(AFTER_LONGEST_COOLDOWN_MS).pipe(
        Effect.andThen(support.refresh(credential)),
      )

    return {
      exchangesAtFailure: counted,
      failure: breakdown,
      kinds: attempts,
      recovered: support.summary(recovered).kind,
    }
  }),
  /* An endpoint failing with 503 until the ceiling is passed, then healthy. */
  outageScript = exchanging(() =>
    exchangesSoFar.pipe(
      Effect.flatMap((sent) =>
        Match.value(sent.length > backoffPolicy.MAX_CONSECUTIVE_TRANSIENT).pipe(
          Match.when(true, () => support.issued("new-access")),
          Match.orElse(() => support.serverError),
        ),
      ),
    ),
  ),
  /* What every attempt up to the ceiling comes to. */
  transientRun = Arr.makeBy(
    backoffPolicy.MAX_CONSECUTIVE_TRANSIENT - ONE_EXCHANGE,
    () => "transient",
  ),
  unreliableEndpoint = refreshLayer(outageScript, fixtureTokens)

describe("refresh during its own cooldown", () => {
  it.effect("adopts a rotated source even during its own cooldown", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const credential = yield* original,
        failed = yield* support.refresh(credential),
        rotated = yield* support.currentRig.pipe(
          Effect.flatMap((rig) =>
            Ref.set(rig.stored, Option.some(support.tokens("rotated-access"))),
          ),
          Effect.andThen(support.refresh(credential)),
        )

      expect(support.summary(failed).kind).toBe("transient")
      expect(support.summary(rotated).access).toStrictEqual(
        Option.some("rotated-access"),
      )
      expect(yield* exchangesSoFar).toHaveLength(ONE_EXCHANGE)
    }).pipe(Effect.provide(limitedWithoutHint)),
  )

  it.effect(
    "returns the existing credential and observes cooldown after a transient",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const credential = yield* original,
          first = yield* support.refresh(credential),
          second = yield* support.refresh(credential),
          waitLeft = Option.getOrElse(
            support.summary(second).retryAfterMs,
            () => NO_EXCHANGES,
          )

        // The endpoint's retry-after becomes the cooldown, and the caller's.
        expect(support.summary(first).retryAfterMs).toStrictEqual(
          Option.some(RETRY_AFTER_MS),
        )
        expect(support.summary(second).kind).toBe("transient")
        expect(waitLeft).toBeGreaterThan(NO_EXCHANGES)
        expect(waitLeft).toBeLessThanOrEqual(RETRY_AFTER_MS)
        expect(yield* exchangesSoFar).toHaveLength(ONE_EXCHANGE)
      }).pipe(Effect.provide(limitedWithHint)),
  )
})

describe("cooldown across credential generations", () => {
  it.effect("shares transient cooldown across credential generations", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      /*
       * Both generations are imported before either refreshes, as at
       * startup: importing an account clears its store's backoff.
       */
      const asImported = yield* Effect.all([original, otherGeneration]),
        first = yield* support.refresh(asImported[FIRST]),
        second = yield* support.refresh(asImported[SECOND])

      expect([
        support.summary(first).kind,
        support.summary(second).kind,
      ]).toStrictEqual(["transient", "transient"])
      expect(yield* exchangesSoFar).toHaveLength(ONE_EXCHANGE)
    }).pipe(Effect.provide(nothingStoredLimited)),
  )
})

describe("refresh through an endpoint outage", () => {
  it.effect(
    "reports repeated transient failures without demanding re-authentication",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const result = yield* outage(yield* original)

        expect(result.failure).toBeInstanceOf(ClaudeAuthRefreshExhaustedError)
        expect(result.failure.message).toMatch(
          /failed 10 times in a row \(HTTP 503\)/u,
        )
        expect(result.failure.message).not.toMatch(/Run `claude`/u)
        /*
         * The refresh token was never rejected, so once the outage ends the
         * next attempt after the cooldown goes through instead of staying
         * blocked.
         */
        expect({
          exchangesAtFailure: result.exchangesAtFailure,
          kinds: result.kinds,
          recovered: result.recovered,
        }).toStrictEqual({
          exchangesAtFailure: backoffPolicy.MAX_CONSECUTIVE_TRANSIENT,
          kinds: transientRun,
          recovered: "refreshed",
        })
        expect(yield* exchangesSoFar).toHaveLength(
          backoffPolicy.MAX_CONSECUTIVE_TRANSIENT + ONE_EXCHANGE,
        )
      }).pipe(Effect.provide(unreliableEndpoint)),
  )
})

describe("refresh while the store cannot be read", () => {
  it.effect(
    "does not spend the refresh token while the source cannot be read",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        /*
         * Refreshing now would rotate the token Claude Code holds without
         * any way to write the replacement back.
         */
        const result = yield* support.refresh(yield* original)

        expect(support.summary(result).kind).toBe("transient")
        expect(yield* exchangesSoFar).toHaveLength(NO_EXCHANGES)
      }).pipe(Effect.provide(lockedKeychain)),
  )

  it.effect("names the unreadable source once retries run out", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const credential = yield* original,
        failure = yield* exhaust(credential)

      expect(failure.message).toMatch(/Keychain is locked/u)
    }).pipe(Effect.provide(lockedKeychain)),
  )
})
