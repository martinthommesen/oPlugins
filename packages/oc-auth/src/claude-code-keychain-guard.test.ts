import { Effect, Option } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type ClaudeCodeStores from "./claude-code-stores.ts"
import FakeKeychain from "./fake-keychain.test-support.ts"
import type { Vitest } from "@effect/vitest"
import sources from "./claude-code-sources.ts"
import support from "./claude-code-stores.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

type Stores = ClaudeCodeStores["Service"]

const ACCOUNT = `${sources.PRIMARY_SERVICE}.account`,
  INTERACTIVE = JSON.stringify(["-i"]),
  OTHER_APP = "Some Other App",
  PRIMARY = sources.PRIMARY_SERVICE,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  TWO_WRITES = 2,
  /** The primary item, already holding the tokens of a newer login. */
  WON_ITEM = [
    [PRIMARY, support.credentialBlob("winner")],
    [ACCOUNT, "me@example.com"],
  ] as const,
  WRITTEN_AS = `${sources.PRIMARY_SERVICE}.written-as`,
  /* The primary item holding `old` under an account, plus `extra` files. */
  primaryWith = (
    extra: readonly (readonly [string, string])[],
  ): readonly (readonly [string, string])[] => [
    [PRIMARY, support.credentialBlob("old")],
    [ACCOUNT, "me@example.com"],
    ...extra,
  ],
  /* Write refreshed tokens into `source`'s store, which held `expected`. */
  refreshing =
    (source: string, expected: string) =>
    (
      stores: Stores,
    ): Effect.Effect<Effect.Success<ReturnType<Stores["writeBack"]>>> =>
      stores.writeBack(support.refresh(source, expected, Option.none())),
  /* The access token the fake Keychain holds under `name`. */
  storedToken = Effect.fn("test.storedToken")(function* storedToken(
    name: string,
  ) {
    const keychain = yield* FakeKeychain

    return support.accessTokenIn(yield* keychain.read(name))
  })

describe("keychain write-back retry", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("tries once more when a write does not land", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const keychain = yield* FakeKeychain,
          result = yield* support.onMac(
            primaryWith([[`${PRIMARY}.drop-once`, ""]]),
            refreshing(PRIMARY, "old"),
          ),
          writes = (yield* keychain.argv).filter(
            (argv) => JSON.stringify(argv) === INTERACTIVE,
          )

        expect(result).toBe("written")
        expect(writes).toHaveLength(TWO_WRITES)
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("keeps the original guard token when it tries again", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        /*
         * The write is lost and the user runs `claude` before the next
         * attempt. Taking the expected token from a fresh read then would
         * compare the item with itself and overwrite that login.
         */
        const result = yield* support.onMac(
          primaryWith([
            [`${PRIMARY}.drop-once`, support.credentialBlob("external")],
          ]),
          refreshing(PRIMARY, "old"),
        )

        expect(result).toBe("conflict")
        expect(yield* storedToken(PRIMARY)).toStrictEqual(
          Option.some("external"),
        )
      }),
    )
  })
})

test.layer(support.layer)(
  "keychain write-back of a lost write",
  (it: Tests) => {
    it.effect("reports a write that did not land as unavailable", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const result = yield* support.onMac(
          primaryWith([[`${PRIMARY}.drop`, ""]]),
          refreshing(PRIMARY, "old"),
        )

        expect(result).toBe("unavailable")
        expect(yield* storedToken(PRIMARY)).toStrictEqual(Option.some("old"))
      }),
    )
  },
)

describe("keychain write-back guard", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect(
      "reports a stale-token conflict and a missing item as failure",
      () =>
        Effect.gen(function* run() {
          expect.assertions(TWO_ASSERTIONS)

          const results = yield* support.onMac(WON_ITEM, (stores) =>
            Effect.all([
              refreshing(PRIMARY, "old")(stores),
              refreshing(`${PRIMARY}-deadbeef`, "old")(stores),
            ]),
          )

          expect(results).toStrictEqual(["conflict", "failed"])
          expect(yield* storedToken(PRIMARY)).toStrictEqual(
            Option.some("winner"),
          )
        }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect(
      "declines when the item rotates while the write is prepared",
      () =>
        Effect.gen(function* run() {
          expect.assertions(THREE_ASSERTIONS)

          const keychain = yield* FakeKeychain,
            result = yield* support.onMac(
              primaryWith([
                [`${PRIMARY}.flip`, support.credentialBlob("external")],
              ]),
              refreshing(PRIMARY, "old"),
            )

          expect(result).toBe("conflict")
          expect(yield* storedToken(PRIMARY)).toStrictEqual(
            Option.some("external"),
          )
          expect(Option.isNone(yield* keychain.read(WRITTEN_AS))).toBe(true)
        }),
    )
  })
})

describe("keychain write-back over a blob it cannot identify", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect(
      "fails rather than writing over a blob that stopped parsing",
      () =>
        Effect.gen(function* run() {
          expect.assertions(TWO_ASSERTIONS)

          const keychain = yield* FakeKeychain,
            result = yield* support.onMac(
              primaryWith([[`${PRIMARY}.flip`, "{ truncated"]]),
              refreshing(PRIMARY, "old"),
            )

          expect(result).toBe("failed")
          expect(yield* keychain.read(PRIMARY)).toStrictEqual(
            Option.some("{ truncated"),
          )
        }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("refuses a `source` that names no Claude Code item", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const result = yield* support.onMac(
          [
            [OTHER_APP, support.credentialBlob("theirs")],
            [`${OTHER_APP}.account`, "them@example.com"],
          ],
          refreshing(OTHER_APP, "theirs"),
        )

        expect(result).toBe("failed")
        expect(yield* storedToken(OTHER_APP)).toStrictEqual(
          Option.some("theirs"),
        )
      }),
    )
  })
})

test.layer(support.layer)("keychain write-back off macOS", (it: Tests) => {
  it.effect("has no Keychain to write to off macOS", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const home = yield* support.sandbox,
        keychain = yield* FakeKeychain,
        result = yield* support.withStores(
          { home, platform: "linux", variables: {} },
          refreshing(PRIMARY, "old"),
        )

      expect(result).toBe("failed")
      expect(yield* keychain.argv).toStrictEqual([])
    }),
  )
})
