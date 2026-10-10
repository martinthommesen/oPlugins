import { Effect, Layer, Option } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import { describe, expect, it } from "@effect/vitest"
import CapturedStderr from "./captured-stderr.test-support.ts"
import DebugLog from "./debug-log.ts"
import accountLabels from "./claude-code-account-labels.ts"
import credentialBlob from "./claude-credentials-blob.ts"
import sources from "./claude-code-sources.ts"
import testEnvironment from "./test-environment.test-support.ts"

const FINGERPRINT = /^[a-f0-9]{32}$/u,
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
  SUFFIX = /^[a-f0-9]{8}$/u,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  /** A quiet debug log, an environment, and Node's platform services. */
  layer = Layer.mergeAll(DebugLog.layer, NodeCrypto.layer).pipe(
    Layer.provideMerge(testEnvironment({ HOME: "/nonexistent" })),
    Layer.provideMerge(
      Layer.mergeAll(
        NodeFileSystem.layer,
        NodePath.layer,
        CapturedStderr.layer,
      ),
    ),
  )

describe("credential blob parsing", () => {
  it.effect("parses wrapped and root credentials", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const root = yield* credentialBlob.parseCredentials(
          JSON.stringify({ accessToken: "a", expiresAt: 1, refreshToken: "r" }),
        ),
        wrapped = yield* credentialBlob.parseCredentials(
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "access",
              expiresAt: 1234.9,
              refreshToken: "refresh",
              subscriptionType: "pro",
            },
          }),
        )

      expect(wrapped).toStrictEqual(
        Option.some({
          accessToken: "access",
          expiresAt: 1234,
          refreshToken: "refresh",
          subscriptionType: "pro",
        }),
      )
      expect(root.pipe(Option.map((found) => found.accessToken))).toStrictEqual(
        Option.some("a"),
      )
    }).pipe(Effect.provide(layer)),
  )

  it.effect("rejects blobs without a usable token pair", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const parsed = yield* Effect.forEach(
        REJECTED,
        (raw) => credentialBlob.parseCredentials(raw),
        { concurrency: "unbounded" },
      )

      expect(parsed).toStrictEqual(REJECTED.map(() => Option.none()))
    }).pipe(Effect.provide(layer)),
  )
})

describe("credential blob updates", () => {
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

  it.effect("replaces the access token inside the wrapper", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)

      const raw = JSON.stringify({
        claudeAiOauth: {
          accessToken: "old",
          expiresAt: 1,
          refreshToken: "refresh",
        },
      })

      expect(credentialBlob.updateCredentialBlob(raw, REFRESHED)).toStrictEqual(
        Option.some(
          JSON.stringify({
            claudeAiOauth: {
              accessToken: "new",
              expiresAt: 2000,
              refreshToken: "new-refresh",
            },
          }),
        ),
      )
    }),
  )
})

describe("account labels", () => {
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

describe("source fingerprints and keys", () => {
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
      }).pipe(Effect.provide(layer)),
  )
})
