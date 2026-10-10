import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import { NodeCrypto } from "@effect/platform-node-shared"
import signing from "./signing.ts"

const ONE_ASSERTION = 1,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2

describe("billing version suffix test vectors", () => {
  it.effect("matches test vector: 'hey' with v2.1.37 gives 0d9", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)
      expect(yield* signing.versionSuffix("hey", "2.1.37")).toBe("0d9")
    }).pipe(Effect.provide(NodeCrypto.layer)),
  )

  it.effect("matches test vector: 'hey' with v2.1.90 gives b39", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)
      expect(yield* signing.versionSuffix("hey", "2.1.90")).toBe("b39")
    }).pipe(Effect.provide(NodeCrypto.layer)),
  )
})

describe("billing version suffix sampling", () => {
  it.effect("pads short messages with '0' for OOB indices", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      /*
       * "hey" is length 3, so indices 4, 7 and 20 all pad to "0", the same
       * sample any other sub-index-4 message produces.
       */
      const hey = yield* signing.versionSuffix("hey", "2.1.37")

      expect(yield* signing.versionSuffix("abc", "2.1.37")).toBe(hey)
      expect(yield* signing.versionSuffix("heyxxxxx", "2.1.37")).not.toBe(hey)
    }).pipe(Effect.provide(NodeCrypto.layer)),
  )

  it.effect("samples correct character indices from long message", () =>
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
    }).pipe(Effect.provide(NodeCrypto.layer)),
  )

  it.effect("handles empty string (all indices pad to '0')", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)
      expect(yield* signing.versionSuffix("", "2.1.90")).toBe("b39")
    }).pipe(Effect.provide(NodeCrypto.layer)),
  )
})

describe("billing header value", () => {
  it.effect("produces correct header for the first user text", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const result = yield* signing.billingHeader("hey", "2.1.295", "sdk-cli")

      expect(result).toMatch(
        /^x-anthropic-billing-header: cc_version=2\.1\.295\./u,
      )
      expect(result).toContain("cc_entrypoint=sdk-cli")
      expect(result).toContain("cch=00000;")
    }).pipe(Effect.provide(NodeCrypto.layer)),
  )

  it.effect(
    "handles missing user message with the CLI's fixed cch placeholder",
    () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)
        expect(
          yield* signing.billingHeader("", "2.1.295", "sdk-cli"),
        ).toContain("cch=00000;")
      }).pipe(Effect.provide(NodeCrypto.layer)),
  )

  it.effect("uses provided entrypoint", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)
      expect(yield* signing.billingHeader("hey", "2.1.112", "cli")).toContain(
        "cc_entrypoint=cli;",
      )
    }).pipe(Effect.provide(NodeCrypto.layer)),
  )
})
