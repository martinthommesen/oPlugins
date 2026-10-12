import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { Effect } from "effect"
import { NodeCrypto } from "@effect/platform-node-shared"
import type { Vitest } from "@effect/vitest"
import signing from "./signing.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof NodeCrypto.layer> | Scope.Scope
  >
}

const ONE_ASSERTION = 1,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2

describe("billing version suffix test vectors", () => {
  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect("matches test vector: 'hey' with v2.1.37 gives 0d9", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)
        expect(yield* signing.versionSuffix("hey", "2.1.37")).toBe("0d9")
      }),
    )
  })

  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect("matches test vector: 'hey' with v2.1.90 gives b39", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)
        expect(yield* signing.versionSuffix("hey", "2.1.90")).toBe("b39")
      }),
    )
  })
})

describe("billing version suffix sampling", () => {
  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect("pads indices past the end of a short message with '0'", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        /*
         * "hey" is 3 characters long, so indices 4, 7, and 20 all pad to "0",
         * as they do for any message shorter than 5 characters.
         */
        const hey = yield* signing.versionSuffix("hey", "2.1.37")

        expect(yield* signing.versionSuffix("abc", "2.1.37")).toBe(hey)
        expect(yield* signing.versionSuffix("heyxxxxx", "2.1.37")).not.toBe(hey)
      }),
    )
  })

  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect("samples indices 4, 7, and 20 of a long message", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)
        /*
         * "Hello, how are you doing today?"
         *  01234567890123456789012345678901
         *      ^  ^            ^
         *  [4]='o' [7]='h' [20]='o'
         */
        expect(
          yield* signing.versionSuffix(
            "Hello, how are you doing today?",
            "2.1.90",
          ),
        ).toBe("494")
      }),
    )
  })

  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect("pads every index of an empty message with '0'", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)
        expect(yield* signing.versionSuffix("", "2.1.90")).toBe("b39")
      }),
    )
  })
})

describe("billing header value", () => {
  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect("builds the header from the first user text", () =>
      Effect.gen(function* run() {
        expect.assertions(THREE_ASSERTIONS)

        const result = yield* signing.billingHeader("hey", "2.1.295", "sdk-cli")

        expect(result).toMatch(
          /^x-anthropic-billing-header: cc_version=2\.1\.295\./u,
        )
        expect(result).toContain("cc_entrypoint=sdk-cli")
        expect(result).toContain("cch=00000;")
      }),
    )
  })

  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect(
      "uses the CLI's fixed cch placeholder when there is no user message",
      () =>
        Effect.gen(function* run() {
          expect.assertions(ONE_ASSERTION)
          expect(
            yield* signing.billingHeader("", "2.1.295", "sdk-cli"),
          ).toContain("cch=00000;")
        }),
    )
  })

  test.layer(NodeCrypto.layer)((it: Tests) => {
    it.effect("uses the given entrypoint", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)
        expect(yield* signing.billingHeader("hey", "2.1.112", "cli")).toContain(
          "cc_entrypoint=cli;",
        )
      }),
    )
  })
})
