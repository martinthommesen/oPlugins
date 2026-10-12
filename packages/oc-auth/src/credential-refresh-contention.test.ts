import { Effect, Fiber, Match, Option, Ref } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import ClaudeAuthTerminalError from "./claude-auth-terminal-error.ts"
import type { Vitest } from "@effect/vitest"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import support from "./credential-refresh.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<ReturnType<typeof refreshLayer>>> | Scope.Scope
  >
}

type Asked = Readonly<Parameters<typeof support.refresh>[typeof FIRST]>

type Refresh = Effect.Success<ReturnType<typeof support.refresh>>

const FIRST = 0,
  IN_PROGRESS_RETRY_MS = 5000,
  NO_EXCHANGES = 0,
  ONE_EXCHANGE = 1,
  TWO_EXCHANGES = 2,
  /*
   * A leader refreshing `asked` whose caller goes away while the endpoint
   * holds the refresh, joined by a caller asking for the same. The joiner's
   * result.
   */
  abandonedLeader = Effect.fn("test.abandonedLeader")(function* abandonedLeader(
    asked: Asked,
  ) {
    const abandoned = yield* Effect.forkChild(support.refresh(asked)).pipe(
        Effect.tap(support.settle),
      ),
      joiner = yield* Effect.forkChild(support.refresh(asked)).pipe(
        Effect.tap(support.settle),
      )

    yield* Fiber.interrupt(abandoned)
    yield* support.currentRig.pipe(Effect.flatMap((rig) => rig.gate.open))

    return yield* Fiber.join(joiner)
  }),
  /* Each refresh's access token, for comparing outcomes. */
  accessOf = (results: readonly Refresh[]): Option.Option<string>[] =>
    results.map((result) => support.summary(result).access),
  /* A newer credential generation of the same store. */
  currentGeneration = support.imported(
    support.account(support.PRIMARY, "current-access"),
  ),
  /*
   * A leader refreshing `stale`, whose token turns out dead, joined by each
   * of `joiners`. The leader's failure and the joiners' results.
   */
  deadLeader = Effect.fn("test.deadLeader")(function* deadLeader(
    stale: Asked,
    joiners: readonly Asked[],
  ) {
    const racing = Effect.all(
        [
          Effect.flip(support.refresh(stale)),
          Effect.forEach(joiners, (joiner) => support.refresh(joiner), {
            concurrency: "unbounded",
          }),
        ],
        { concurrency: "unbounded" },
      ),
      started = yield* Effect.forkChild(racing)

    yield* support.settle
    yield* support.currentRig.pipe(Effect.flatMap((rig) => rig.gate.open))

    return yield* Fiber.join(started)
  }),
  /* The refresh tokens the rig's endpoint has seen, in order. */
  exchangesSoFar = support.currentRig.pipe(
    Effect.flatMap((rig) => Ref.get(rig.exchanged)),
  ),
  /* A store whose endpoint renews its refresh token once the gate opens. */
  gatedEndpoint = refreshLayer(
    Object.freeze({
      acquire: support.script.acquire,
      exchange: () =>
        support.currentRig.pipe(
          Effect.flatMap((rig) => rig.gate.await),
          Effect.andThen(support.issued("new-access")),
        ),
      read: support.script.read,
      writeBack: support.script.writeBack,
    }),
  )(Option.some(support.account().credentials)),
  /*
   * A store with nothing in it, whose endpoint rejects the first refresh
   * token once the gate opens and renews the second.
   */
  leaderDies = refreshLayer(
    Object.freeze({
      acquire: support.script.acquire,
      exchange: () =>
        support.currentRig.pipe(
          Effect.flatMap((rig) => Ref.get(rig.exchanged)),
          Effect.flatMap((sent) =>
            Match.value(sent.length).pipe(
              Match.when(ONE_EXCHANGE, () =>
                support.currentRig.pipe(
                  Effect.flatMap((rig) => rig.gate.await),
                  Effect.andThen(support.invalidGrant),
                ),
              ),
              Match.orElse(() => support.issued("new-access")),
            ),
          ),
        ),
      read: support.script.read,
      writeBack: support.script.writeBack,
    }),
  )(Option.none()),
  original = support.imported(support.account()),
  otherBusy = refreshLayer(
    Object.freeze({
      acquire: support.busy,
      exchange: support.script.exchange,
      read: support.script.read,
      writeBack: support.script.writeBack,
    }),
  )(Option.some(support.account().credentials))

test.layer(otherBusy)(
  "refresh while another process refreshes",
  (it: Tests) => {
    it.effect("defers when another process owns the lock", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const result = yield* support.polled(support.refresh(yield* original))

        expect(support.summary(result)).toStrictEqual({
          access: Option.none(),
          kind: "transient",
          retryAfterMs: Option.some(IN_PROGRESS_RETRY_MS),
        })
        expect(yield* exchangesSoFar).toHaveLength(NO_EXCHANGES)
      }),
    )
  },
)

describe("refresh joining a leader whose token died", () => {
  test.layer(leaderDies)((it: Tests) => {
    it.effect(
      "lets a newer generation refresh itself after joining a dead leader",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const [leader, joiners] = yield* deadLeader(yield* original, [
            yield* currentGeneration,
          ])

          expect(leader).toBeInstanceOf(ClaudeAuthTerminalError)
          expect(accessOf(joiners)).toStrictEqual([Option.some("new-access")])
          expect(yield* exchangesSoFar).toHaveLength(TWO_EXCHANGES)
        }),
    )
  })

  test.layer(leaderDies)((it: Tests) => {
    it.effect(
      "shares one refresh between newer generations that joined a dead leader",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const current = yield* currentGeneration,
            [leader, joiners] = yield* deadLeader(yield* original, [
              current,
              current,
            ])

          expect(leader).toBeInstanceOf(ClaudeAuthTerminalError)
          expect(accessOf(joiners)).toStrictEqual([
            Option.some("new-access"),
            Option.some("new-access"),
          ])
          // One exchange for the dead leader, and one the joiners share.
          expect(yield* exchangesSoFar).toHaveLength(TWO_EXCHANGES)
        }),
    )
  })
})

test.layer(gatedEndpoint)(
  "refresh whose leader's caller goes away",
  (it: Tests) => {
    it.effect("still settles the refresh for a caller that joined it", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* support.begin

        const joined = yield* abandonedLeader(yield* original)

        expect(support.summary(joined).access).toStrictEqual(
          Option.some("new-access"),
        )
        expect(yield* exchangesSoFar).toHaveLength(ONE_EXCHANGE)
        // The leader's write-back runs, so Claude Code keeps the new tokens.
        expect(
          yield* support.currentRig.pipe(
            Effect.flatMap((rig) => Ref.get(rig.writes)),
          ),
        ).toHaveLength(ONE_EXCHANGE)
      }),
    )
  },
)
