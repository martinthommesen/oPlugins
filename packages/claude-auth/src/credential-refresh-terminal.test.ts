import { Effect, Match, Option, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import ClaudeAuthTerminalError from "./claude-auth-terminal-error.ts"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import support from "./credential-refresh.test-support.ts"

type Script = typeof support.script

const ONE_EXCHANGE = 1,
  RETRY_AFTER_MS = 10_000,
  /* A healthy rig whose endpoint answers `exchange` instead. */
  answering = (exchange: Script["exchange"]): Script =>
    Object.freeze({
      acquire: support.script.acquire,
      exchange,
      read: support.script.read,
      writeBack: support.script.writeBack,
    }),
  /* What the store holds when the account is imported. */
  atImport = Option.some(support.account().credentials),
  /* A newer credential generation of the same store. */
  currentGeneration = support.imported(
    support.account(support.PRIMARY, "current-access"),
  ),
  /* An endpoint that rejects the first refresh token and renews the next. */
  deadThenRenewed = answering(() =>
    support.currentRig.pipe(
      Effect.flatMap((rig) => Ref.get(rig.exchanged)),
      Effect.flatMap((sent) =>
        Match.value(sent.length).pipe(
          Match.when(ONE_EXCHANGE, () => support.invalidGrant),
          Match.orElse(() => support.issued("new-access")),
        ),
      ),
    ),
  ),
  deadThenRenewedEmpty = refreshLayer(deadThenRenewed, Option.none()),
  deadThenRenewedStored = refreshLayer(deadThenRenewed, atImport),
  deadToken = refreshLayer(
    answering(() => support.invalidGrant),
    atImport,
  ),
  limitedWithHint = refreshLayer(
    answering(() => support.rateLimited(Option.some(RETRY_AFTER_MS))),
    atImport,
  ),
  /* What the fake held lock has been asked to do, in order. */
  lockEventsSoFar = support.currentRig.pipe(
    Effect.flatMap((rig) => Ref.get(rig.lockEvents)),
  ),
  original = support.imported(support.account()),
  /*
   * An endpoint that rejects the refresh token because Claude Code rotated
   * the store meanwhile.
   */
  rotatesThenRejects = refreshLayer(
    answering(() =>
      support.currentRig.pipe(
        Effect.flatMap((rig) =>
          Ref.set(
            rig.stored,
            Option.some(support.tokens("rotated-access", "rotated-refresh")),
          ),
        ),
        Effect.andThen(support.invalidGrant),
      ),
    ),
    atImport,
  )

describe("refresh with a dead refresh token", () => {
  it.effect("reports a terminal refresh with reauthentication guidance", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const failure = yield* Effect.flip(support.refresh(yield* original))

      expect(failure).toBeInstanceOf(ClaudeAuthTerminalError)
      expect(failure.message).toMatch(/Run `claude`/u)
    }).pipe(Effect.provide(deadToken)),
  )

  it.effect("adopts a rotated source instead of failing on invalid_grant", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const result = yield* support.refresh(yield* original)

      expect(support.summary(result)).toStrictEqual({
        access: Option.some("rotated-access"),
        kind: "adopted",
        retryAfterMs: Option.none(),
      })
    }).pipe(Effect.provide(rotatesThenRejects)),
  )
})

describe("terminal state across credential generations", () => {
  it.effect(
    "does not apply a stale generation's terminal state to a newer one",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const failure = yield* Effect.flip(support.refresh(yield* original)),
          refreshed = yield* support.refresh(yield* currentGeneration)

        expect(failure).toBeInstanceOf(ClaudeAuthTerminalError)
        expect(support.summary(refreshed)).toStrictEqual({
          access: Option.some("new-access"),
          kind: "refreshed",
          retryAfterMs: Option.none(),
        })
      }).pipe(Effect.provide(deadThenRenewedEmpty)),
  )

  it.effect("clears terminal state when the account is imported again", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const failure = yield* Effect.flip(support.refresh(yield* original)),
        importedAgain = yield* original,
        refreshedAgain = yield* support.refresh(importedAgain)

      expect(failure).toBeInstanceOf(ClaudeAuthTerminalError)
      expect(support.summary(refreshedAgain).kind).toBe("refreshed")
    }).pipe(Effect.provide(deadThenRenewedStored)),
  )
})

describe("the refresh lock on every path", () => {
  it.effect("defers the lock after a transient, then releases it", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin
      yield* support.refresh(yield* original)

      expect(yield* lockEventsSoFar).toStrictEqual([
        `defer:${RETRY_AFTER_MS}`,
        "release",
      ])
    }).pipe(Effect.provide(limitedWithHint)),
  )

  it.effect("releases the lock after a terminal failure", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin
      yield* Effect.flip(support.refresh(yield* original))

      expect(yield* lockEventsSoFar).toStrictEqual(["release"])
    }).pipe(Effect.provide(deadToken)),
  )
})
