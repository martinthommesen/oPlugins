import { Effect, Encoding, Option, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type ClaudeCodeStores from "./claude-code-stores.ts"
import FakeKeychain from "./fake-keychain.test-support.ts"
import sources from "./claude-code-sources.ts"
import support from "./claude-code-stores.test-support.ts"

type Stores = ClaudeCodeStores["Service"]

const ACCOUNT = `${sources.PRIMARY_SERVICE}.account`,
  /** Account names that print as hex, or that the shell would split. */
  AWKWARD_ACCOUNTS = ['has"quote', String.raw`back\slash`, "ünïcode", "sp ace"],
  /** The token of an MCP server in a blob. */
  HeldServer = Schema.Struct({
    server: Schema.Struct({ accessToken: Schema.String }),
  }),
  /** A stored blob's fields beyond the tokens, which write-back keeps. */
  KeptFields = Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.Struct({
        accessToken: Schema.String,
        subscriptionType: Schema.String,
      }),
    }),
  ),
  /** A blob padded past one `security -i` line. */
  LargeBlob = Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.Struct({ accessToken: Schema.String }),
      mcpOAuth: HeldServer,
    }),
  ),
  /** A blob carrying a note in non-ASCII text. */
  NotedBlob = Schema.fromJsonString(
    Schema.Struct({ claudeAiOauth: Schema.Struct({ note: Schema.String }) }),
  ),
  ONE_ASSERTION = 1,
  PADDING_LENGTH = 6000,
  PRIMARY = sources.PRIMARY_SERVICE,
  SECRETS = ["new-access-secret", "new-refresh-secret"],
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  WRITTEN_AS = `${sources.PRIMARY_SERVICE}.written-as`,
  padding = "m".repeat(PADDING_LENGTH),
  /* The primary item holding `blob`, under the account `me@example.com`. */
  primaryHolding = (blob: string): readonly (readonly [string, string])[] => [
    [PRIMARY, blob],
    [ACCOUNT, "me@example.com"],
  ],
  /* Write refreshed tokens over the primary item, which held `old`. */
  refreshPrimary = (
    stores: Stores,
  ): Effect.Effect<Effect.Success<ReturnType<Stores["writeBack"]>>> =>
    stores.writeBack(support.refresh(PRIMARY, "old", Option.none())),
  /* The result of a write under `account`, and the account it landed under. */
  writtenUnder = (
    account: string,
  ): Effect.Effect<readonly [string, Option.Option<string>]> =>
    Effect.gen(function* run() {
      const keychain = yield* FakeKeychain,
        result = yield* support.onMac(
          [
            [PRIMARY, support.credentialBlob("old")],
            [ACCOUNT, account],
          ],
          refreshPrimary,
        )

      return [result, yield* keychain.read(WRITTEN_AS)] as const
    }).pipe(Effect.scoped, Effect.provide(support.layer), Effect.orDie)

describe("keychain write-back", () => {
  it.effect("writes refreshed tokens back to the item's existing account", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const keychain = yield* FakeKeychain,
        result = yield* support.onMac(
          primaryHolding(support.credentialBlob("old")),
          refreshPrimary,
        ),
        stored = yield* keychain.read(PRIMARY)

      expect(result).toBe("written")
      expect(
        stored.pipe(
          Option.flatMap((blob) =>
            Schema.decodeUnknownOption(KeptFields)(blob),
          ),
          Option.map((blob) => blob.claudeAiOauth),
        ),
      ).toStrictEqual(
        Option.some({ accessToken: "new", subscriptionType: "pro" }),
      )
      expect(yield* keychain.read(WRITTEN_AS)).toStrictEqual(
        Option.some("me@example.com"),
      )
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("keychain write-back and the process list", () => {
  it.effect("keeps the refreshed tokens off the command line", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const keychain = yield* FakeKeychain,
        result = yield* support.onMac(
          primaryHolding(support.credentialBlob("old")),
          (stores) =>
            stores.writeBack({
              configDir: Option.none(),
              credentials: {
                accessToken: "new-access-secret",
                expiresAt: 3000,
                refreshToken: "new-refresh-secret",
              },
              expectedAccessToken: "old",
              source: PRIMARY,
            }),
        ),
        visible = JSON.stringify(yield* keychain.argv).toLowerCase()

      expect(result).toBe("written")
      expect(
        SECRETS.flatMap((secret) => [
          secret,
          Encoding.encodeHex(secret),
        ]).filter((needle) => visible.includes(needle)),
      ).toStrictEqual([])
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("keychain write-back of a long blob", () => {
  it.effect("writes a blob too long for one interactive line in full", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const keychain = yield* FakeKeychain,
        result = yield* support.onMac(
          primaryHolding(
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "old",
                expiresAt: 2000,
                refreshToken: "x",
              },
              mcpOAuth: { server: { accessToken: padding } },
            }),
          ),
          refreshPrimary,
        ),
        stored = yield* keychain.read(PRIMARY)

      expect(result).toBe("written")
      expect(
        stored.pipe(
          Option.flatMap((blob) => Schema.decodeUnknownOption(LargeBlob)(blob)),
        ),
      ).toStrictEqual(
        Option.some({
          claudeAiOauth: { accessToken: "new" },
          mcpOAuth: { server: { accessToken: padding } },
        }),
      )
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("keychain write-back of non-ASCII text", () => {
  it.effect("keeps a written blob readable when it holds non-ASCII text", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const keychain = yield* FakeKeychain,
        result = yield* support.onMac(
          primaryHolding(
            JSON.stringify({
              claudeAiOauth: {
                accessToken: "old",
                expiresAt: 2000,
                note: "ünïcode",
                refreshToken: "x",
              },
            }),
          ),
          refreshPrimary,
        ),
        stored = Option.getOrElse(yield* keychain.read(PRIMARY), () => "")

      expect(result).toBe("written")
      expect(stored).toMatch(/^[\u0020-\u007E]*$/u)
      expect(Schema.decodeUnknownOption(NotedBlob)(stored)).toStrictEqual(
        Option.some({ claudeAiOauth: { note: "ünïcode" } }),
      )
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("keychain write-back under the item's account", () => {
  it.effect("writes under the exact account name, however it prints", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const written = yield* Effect.forEach(
        AWKWARD_ACCOUNTS,
        (account) => writtenUnder(account),
        { concurrency: 1 },
      )

      expect(written).toStrictEqual(
        AWKWARD_ACCOUNTS.map((account) => ["written", Option.some(account)]),
      )
    }),
  )

  it.effect("refuses to write when the item's account name is unknown", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const keychain = yield* FakeKeychain,
        result = yield* support.onMac(
          [[PRIMARY, support.credentialBlob("old")]],
          refreshPrimary,
        )

      // An item without an account cannot be updated in place, and asking
      // Again will not give it one.
      expect(result).toBe("failed")
      expect(
        support.accessTokenIn(yield* keychain.read(PRIMARY)),
      ).toStrictEqual(Option.some("old"))
      expect(Option.isNone(yield* keychain.read(WRITTEN_AS))).toBe(true)
    }).pipe(Effect.provide(support.layer)),
  )
})
