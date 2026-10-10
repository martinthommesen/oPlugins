import { Effect, Option, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import CapturedStderr from "./captured-stderr.test-support.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import sources from "./claude-code-sources.ts"
import support from "./credential-refresh.test-support.ts"

type Script = typeof support.script

type WriteResult = Effect.Success<ReturnType<Script["writeBack"]>>

const ONE_MS = 1,
  SINGLE_WRITE = 1,
  UNCHANGED = {
    access: Option.none(),
    kind: "unchanged",
    retryAfterMs: Option.none(),
  },
  /* A store holding the old tokens whose write-back answers `result`. */
  answering = (result: WriteResult): ReturnType<typeof refreshLayer> =>
    refreshLayer(
      Object.freeze({
        acquire: support.script.acquire,
        exchange: support.script.exchange,
        read: support.script.read,
        writeBack: () => Effect.succeed(result),
      }),
      Option.some(support.account().credentials),
    ),
  /*
   * A store whose write-back meets a conflict: another writer leaves
   * `winner` in place first.
   */
  conflictWith = (
    winner: ReturnType<typeof support.tokens>,
  ): ReturnType<typeof refreshLayer> =>
    refreshLayer(
      Object.freeze({
        acquire: support.script.acquire,
        exchange: support.script.exchange,
        read: support.script.read,
        writeBack: () =>
          support.currentRig.pipe(
            Effect.flatMap((rig) => Ref.set(rig.stored, Option.some(winner))),
            Effect.as("conflict" as const),
          ),
      }),
      Option.some(support.account().credentials),
    ),
  /* A conflicting winner that expired, so it cannot be adopted. */
  expiredWinner = conflictWith(
    support.tokens("expired-winner", "r", support.BASE_TIME - ONE_MS),
  ),
  /* The source-token fingerprint a result's credential carries. */
  hashAfter = (
    result: Effect.Success<ReturnType<typeof support.refresh>>,
  ): Option.Option<string> =>
    support.credentialAfter(result).pipe(
      Option.flatMap((credential) =>
        claudeCodeCredential.readMetadata(credential),
      ),
      Option.map((metadata) => metadata.sourceTokenHash),
    ),
  /* A conflicting winner that is still valid. */
  liveWinner = conflictWith(support.tokens("winner-access", "winner-refresh")),
  original = support.imported(support.account()),
  rotatedElsewhere = refreshLayer(
    support.script,
    Option.some(support.tokens("external-access", "external-refresh")),
  ),
  /* What the rig's store has been asked to write, in order. */
  writesSoFar = support.currentRig.pipe(
    Effect.flatMap((rig) => Ref.get(rig.writes)),
  )

describe("adoption of an external credential", () => {
  it.effect("adopts a distinct usable source credential", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const adopted = yield* support.adopt(yield* original)

      expect(support.summary(adopted)).toStrictEqual({
        access: Option.some("external-access"),
        kind: "adopted",
        retryAfterMs: Option.none(),
      })
    }).pipe(Effect.provide(rotatedElsewhere)),
  )
})

describe("refresh whose write-back failed", () => {
  it.effect("does not resurrect the stale source left by a failed write", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const refreshed = yield* support.refresh(yield* original),
        retried = yield* Effect.forEach(
          Option.toArray(support.credentialAfter(refreshed)),
          (next) => support.adopt(next),
        )

      expect(support.summary(refreshed).access).toStrictEqual(
        Option.some("new-access"),
      )
      expect(retried.map((result) => support.summary(result))).toStrictEqual([
        UNCHANGED,
      ])
    }).pipe(Effect.provide(answering("failed"))),
  )

  it.effect("does not retry a write the store already decided against", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin
      yield* support.refresh(yield* original)

      // A failed write is a decision about the stored blob; repeating the
      // Whole guarded sequence reaches the same conclusion.
      expect(yield* writesSoFar).toHaveLength(SINGLE_WRITE)
    }).pipe(Effect.provide(answering("failed"))),
  )
})

describe("write-back warnings", () => {
  it.effect(
    "warns that Claude Code will be signed out when write-back fails",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin
        yield* support.refresh(yield* original)

        const text = yield* (yield* CapturedStderr).text

        expect(text.trim().split("\n")).toHaveLength(SINGLE_WRITE)
        expect(text).toMatch(/could not be saved/u)
      }).pipe(Effect.provide(answering("failed"))),
  )

  it.effect("does not warn when write-back lands", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin
      yield* support.refresh(yield* original)

      expect(yield* (yield* CapturedStderr).text).toBe("")
    }).pipe(Effect.provide(answering("written"))),
  )
})

describe("refresh whose store stays unreachable", () => {
  it.effect("keeps the source hash when the store stays unreachable", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const oldHash = yield* sources.tokenFingerprint("old-access"),
        refreshed = yield* support.refresh(yield* original)

      // The store retries; this layer does not.
      expect(yield* writesSoFar).toHaveLength(SINGLE_WRITE)
      expect(support.summary(refreshed).kind).toBe("refreshed")
      expect(hashAfter(refreshed)).toStrictEqual(Option.some(oldHash))
    }).pipe(Effect.provide(answering("unavailable"))),
  )
})

describe("refresh that meets a write-back conflict", () => {
  it.effect(
    "keeps its own refresh when a conflicting winner is not adoptable",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const oldHash = yield* sources.tokenFingerprint("old-access"),
          refreshed = yield* support.refresh(yield* original)

        expect(support.summary(refreshed)).toStrictEqual({
          access: Option.some("new-access"),
          kind: "refreshed",
          retryAfterMs: Option.none(),
        })
        expect(hashAfter(refreshed)).toStrictEqual(Option.some(oldHash))
      }).pipe(Effect.provide(expiredWinner)),
  )

  it.effect("adopts the winning source after a write-back conflict", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const result = yield* support.refresh(yield* original)

      expect(support.summary(result)).toStrictEqual({
        access: Option.some("winner-access"),
        kind: "adopted",
        retryAfterMs: Option.none(),
      })
    }).pipe(Effect.provide(liveWinner)),
  )
})
