import { Effect, Fiber, Match, Option, Ref } from "effect"
import type { Layer, Scope } from "effect"
import { expect, it as test } from "@effect/vitest"
import ClaudeAuthTerminalError from "./claude-auth-terminal-error.ts"
import type { Vitest } from "@effect/vitest"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import support from "./credential-refresh.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof refreshLayer>> | Scope.Scope
  >
}

type Asked = Readonly<Parameters<typeof support.refresh>[typeof FIRST]>

const FIRST = 0,
  IN_PROGRESS_RETRY_MS = 5000,
  NO_EXCHANGES = 0,
  ONE_EXCHANGE = 1,
  TWO_EXCHANGES = 2,
  /*
   * A leader refreshing `stale`, whose token turns out dead, joined by
   * `current`, a newer generation of the same store. The leader's failure
   * and the joiner's result.
   */
  deadLeader = Effect.fn("test.deadLeader")(function* deadLeader(
    stale: Asked,
    current: Asked,
  ) {
    const racing = Effect.all(
        [Effect.flip(support.refresh(stale)), support.refresh(current)],
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
    Option.none(),
  ),
  original = support.imported(support.account()),
  otherBusy = refreshLayer(
    Object.freeze({
      acquire: support.busy,
      exchange: support.script.exchange,
      read: support.script.read,
      writeBack: support.script.writeBack,
    }),
    Option.some(support.account().credentials),
  )

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

test.layer(leaderDies)(
  "refresh joining a leader whose token died",
  (it: Tests) => {
    it.effect(
      "lets a newer generation refresh itself after joining a dead leader",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const [leader, joiner] = yield* deadLeader(
            yield* original,
            yield* support.imported(
              support.account(support.PRIMARY, "current-access"),
            ),
          )

          expect(leader).toBeInstanceOf(ClaudeAuthTerminalError)
          expect(support.summary(joiner).access).toStrictEqual(
            Option.some("new-access"),
          )
          expect(yield* exchangesSoFar).toHaveLength(TWO_EXCHANGES)
        }),
    )
  },
)
