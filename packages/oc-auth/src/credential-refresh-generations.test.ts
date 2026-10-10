import { Effect, Fiber, Match, Option, Ref, Struct } from "effect"
import type { Layer, Scope } from "effect"
import { expect, it as test } from "@effect/vitest"
import type { Vitest } from "@effect/vitest"
import claudeCodeCredential from "./claude-code-credential.ts"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import support from "./credential-refresh.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<ReturnType<typeof refreshLayer>>> | Scope.Scope
  >
}

type Script = typeof support.script

type Asked = Readonly<Parameters<typeof support.refresh>[typeof FIRST]>

type Refresh = Effect.Success<ReturnType<typeof support.refresh>>

const FIRST = 0,
  FIRST_READ = 1,
  ONE_EXCHANGE = 1,
  ONE_MS = 1,
  TWO_EXCHANGES = 2,
  /* Each refresh's access token, for comparing outcomes. */
  accessOf = (results: readonly Refresh[]): Option.Option<string>[] =>
    results.map((result) => support.summary(result).access),
  /* `first` and `second` refreshed at once, released together by the gate. */
  atOnce = Effect.fn("test.atOnce")(function* atOnce(
    first: Asked,
    second: Asked,
  ) {
    const both = yield* Effect.forkChild(
      Effect.all([support.refresh(first), support.refresh(second)], {
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
  /* Tokens Claude Code rotated in that expired before anyone used them. */
  expiredTokens = support.tokens(
    "latest-expired",
    "latest-refresh",
    support.BASE_TIME - ONE_MS,
  ),
  /* A file-store account in `configDir` holding `name` tokens. */
  fileAccount = (name: string): ReturnType<typeof support.account> =>
    Struct.assign(support.account("file", `${name}-access`), {
      configDir: `/claude/${name}`,
      credentials: support.tokens(`${name}-access`, `${name}-refresh`),
    }),
  /* Two file stores, each answering with its own tokens. */
  fileStores = refreshLayer(
    Object.freeze({
      acquire: support.script.acquire,
      exchange: (refreshToken: string) =>
        support.issued(refreshToken.replace("-refresh", "-access-new")),
      read: (_source: string, configDir: Option.Option<string>) =>
        Effect.succeed(
          configDir.pipe(
            Option.map((dir) =>
              support.tokens(
                `${dir.replace("/claude/", "")}-access`,
                `${dir.replace("/claude/", "")}-refresh`,
              ),
            ),
          ),
        ),
      writeBack: support.script.writeBack,
    }),
  )(Option.none()),
  firstFile = support.imported(fileAccount("first")),
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
  generationsStore = refreshLayer(gatedScript)(Option.some(expiredTokens)),
  /* The label carried by the credential a result holds. */
  labelOf = (result: Refresh): Option.Option<string> =>
    support
      .credentialAfter(result)
      .pipe(
        Option.flatMapNullishOr((credential) =>
          claudeCodeCredential.credentialLabel(credential),
        ),
      ),
  /* An expired generation of the primary store, with its own label. */
  labelledGeneration = support.imported(
    Struct.assign(support.account(support.PRIMARY, "latest-expired"), {
      credentials: expiredTokens,
      label: "Second persisted label",
    }),
  ),
  original = support.imported(support.account()),
  /*
   * A store that still holds the old tokens when first read, and an expired
   * external rotation once the lock is held.
   */
  rotatedAfterLock = refreshLayer(
    Object.freeze({
      acquire: support.script.acquire,
      exchange: support.script.exchange,
      read: () =>
        support.currentRig.pipe(
          Effect.flatMap((rig) => Ref.get(rig.reads)),
          Effect.map((reads) =>
            Match.value(reads.length).pipe(
              Match.when(FIRST_READ, () => support.account().credentials),
              Match.orElse(() => expiredTokens),
              Option.some,
            ),
          ),
        ),
      writeBack: support.script.writeBack,
    }),
  )(Option.none()),
  secondFile = support.imported(fileAccount("second"))

test.layer(generationsStore)(
  "refresh of two generations of one store",
  (it: Tests) => {
    it.effect(
      "coordinates different credential generations for one source",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const [first, second] = yield* atOnce(
            yield* original,
            yield* labelledGeneration,
          )

          expect(yield* exchangesSoFar).toHaveLength(ONE_EXCHANGE)
          expect(accessOf([first, second])).toStrictEqual([
            Option.some("new-access"),
            Option.some("new-access"),
          ])
          expect(labelOf(second)).toStrictEqual(
            Option.some("Second persisted label"),
          )
        }),
    )
  },
)

test.layer(fileStores)("refresh of distinct file stores", (it: Tests) => {
  it.effect("does not share refreshes between different file sources", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* support.begin

      const credentialOne = yield* firstFile,
        credentialTwo = yield* secondFile,
        results = yield* Effect.all(
          [support.refresh(credentialOne), support.refresh(credentialTwo)],
          { concurrency: "unbounded" },
        )

      expect(yield* exchangesSoFar).toHaveLength(TWO_EXCHANGES)
      expect(accessOf(results)).toStrictEqual([
        Option.some("first-access-new"),
        Option.some("second-access-new"),
      ])
    }),
  )
})

test.layer(rotatedAfterLock)(
  "refresh after an expired external rotation",
  (it: Tests) => {
    it.effect(
      "uses one post-lock source snapshot for an expired external rotation",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* support.begin

          const result = yield* support.refresh(yield* original),
            rig = yield* support.currentRig

          expect(yield* Ref.get(rig.exchanged)).toStrictEqual([
            "latest-refresh",
          ])
          expect(
            (yield* Ref.get(rig.writes)).map(
              (write) => write.expectedAccessToken,
            ),
          ).toStrictEqual(["latest-expired"])
          expect(support.summary(result).access).toStrictEqual(
            Option.some("new-access"),
          )
        }),
    )
  },
)
