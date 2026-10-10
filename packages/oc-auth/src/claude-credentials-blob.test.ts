import { Effect, Layer, Option } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedStderr from "./captured-stderr.test-support.ts"
import DebugLog from "./debug-log.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import accountLabels from "./claude-code-account-labels.ts"
import credentialBlob from "./claude-credentials-blob.ts"
import sources from "./claude-code-sources.ts"
import testEnvironment from "./test-environment.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Layer.Success<typeof layer> | Scope.Scope>
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

const FINGERPRINT = /^[a-f0-9]{32}$/u,
  /** The wrapped blob `OLD_WRAPPED` becomes once refreshed. */
  NEW_WRAPPED = JSON.stringify({
    claudeAiOauth: {
      accessToken: "new",
      expiresAt: 2000,
      refreshToken: "new-refresh",
    },
  }),
  /** A wrapped blob, as Claude Code stores it, holding old tokens. */
  OLD_WRAPPED = JSON.stringify({
    claudeAiOauth: {
      accessToken: "old",
      expiresAt: 1,
      refreshToken: "refresh",
    },
  }),
  ONE_ASSERTION = 1,
  REFRESHED = {
    accessToken: "new",
    expiresAt: 2000,
    refreshToken: "new-refresh",
  },
  /** Blobs that hold no usable credential. */
  REJECTED = [
    "not json",
    "null",
    JSON.stringify({ accessToken: "", expiresAt: 1, refreshToken: "r" }),
    JSON.stringify({
      accessToken: "a",
      expiresAt: Number.POSITIVE_INFINITY,
      refreshToken: "r",
    }),
    JSON.stringify({ mcpOAuth: { server: {} } }),
  ],
  /** A blob holding the token pair at its root. */
  ROOT_BLOB = JSON.stringify({
    accessToken: "a",
    expiresAt: 1,
    refreshToken: "r",
  }),
  SUFFIX = /^[a-f0-9]{8}$/u,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  /** A blob holding the token pair inside Claude Code's wrapper. */
  WRAPPED_BLOB = JSON.stringify({
    claudeAiOauth: {
      accessToken: "access",
      expiresAt: 1234.9,
      refreshToken: "refresh",
      subscriptionType: "pro",
    },
  }),
  /** A quiet debug log, an environment, and Node's platform services. */
  layer = Layer.mergeAll(DebugLog.layer, NodeCrypto.layer).pipe(
    Layer.provideMerge(testEnvironment({ HOME: "/nonexistent" })()),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        CapturedStderr.layer,
      ),
    ),
  )

describe("credential blob parsing", () => {
  test.layer(layer)((it: Tests) => {
    it.effect("parses wrapped and root credentials", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const root = yield* credentialBlob.parseCredentials(ROOT_BLOB),
          wrapped = yield* credentialBlob.parseCredentials(WRAPPED_BLOB)

        expect(wrapped).toStrictEqual(
          Option.some({
            accessToken: "access",
            expiresAt: 1234,
            refreshToken: "refresh",
            subscriptionType: "pro",
          }),
        )
        expect(
          root.pipe(Option.map((found) => found.accessToken)),
        ).toStrictEqual(Option.some("a"))
      }),
    )
  })

  test.layer(layer)((it: Tests) => {
    it.effect("rejects blobs without a usable token pair", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const parsed = yield* Effect.forEach(
          REJECTED,
          (raw) => credentialBlob.parseCredentials(raw),
          { concurrency: "unbounded" },
        )

        expect(parsed).toStrictEqual(REJECTED.map(() => Option.none()))
      }),
    )
  })
})

describe("credential blob updates", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("refuses to update a blob that is not a credential object", () =>
      Effect.sync(() => {
        expect.assertions(ONE_ASSERTION)

        expect(
          ["null", "[]", "3", '{"claudeAiOauth":"text"}'].map((raw) =>
            credentialBlob.updateCredentialBlob(raw, REFRESHED),
          ),
        ).toStrictEqual([
          Option.none(),
          Option.none(),
          Option.none(),
          Option.none(),
        ])
      }),
    )
  })

  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("replaces the access token inside the wrapper", () =>
      Effect.sync(() => {
        expect.assertions(ONE_ASSERTION)

        expect(
          credentialBlob.updateCredentialBlob(OLD_WRAPPED, REFRESHED),
        ).toStrictEqual(Option.some(NEW_WRAPPED))
      }),
    )
  })
})

test.layer(Layer.empty)("account labels", (it: PureTests) => {
  it.effect("labels duplicate subscription tiers with account details", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)

      const credentials = {
        accessToken: "a",
        expiresAt: 1,
        refreshToken: "r",
        subscriptionType: "pro",
      }

      expect(
        accountLabels.buildAccountLabels([
          {
            credentials,
            email: Option.some("a@example.com"),
            source: Option.some("one"),
          },
          { credentials, email: Option.none(), source: Option.some("two") },
        ]),
      ).toStrictEqual(["Claude Pro 1: a@example.com", "Claude Pro 2: two"])
    }),
  )
})

test.layer(layer)("source fingerprints and keys", (it: Tests) => {
  it.effect(
    "creates stable non-secret source fingerprints and config suffixes",
    () =>
      Effect.gen(function* run() {
        expect.assertions(THREE_ASSERTIONS)

        const [token, other, suffix, one, two] = yield* Effect.all([
          sources.tokenFingerprint("token"),
          sources.tokenFingerprint("other"),
          sources.keychainSuffixForDir("/tmp/claude"),
          sources.credentialSourceID("file", Option.some("/tmp/one")),
          sources.credentialSourceID("file", Option.some("/tmp/two")),
        ])

        expect([
          FINGERPRINT.test(token),
          token.includes("token"),
          token === other,
        ]).toStrictEqual([true, false, false])
        expect(suffix).toMatch(SUFFIX)
        expect(one).not.toBe(two)
      }),
  )
})
