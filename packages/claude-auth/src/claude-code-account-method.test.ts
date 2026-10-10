import { Effect, Exit, Option, Ref } from "effect"
import { describe, expect, it } from "@effect/vitest"
import accountMethod from "./claude-code-account-method.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import refreshLayer from "./credential-refresh-layer.test-support.ts"
import sources from "./claude-code-sources.ts"
import support from "./credential-refresh.test-support.ts"

type Account = ReturnType<typeof support.account>

/*
 * Real Keychain service names: credential metadata is validated on the way
 * back in, so a fixture using an arbitrary name would not round-trip.
 */
const ACCOUNT_A = "Claude Code-credentials-aaaaaaaa",
  ACCOUNT_B = "Claude Code-credentials-bbbbbbbb",
  ACCOUNT_C = "Claude Code-credentials-cccccccc",
  accountA = support.account(ACCOUNT_A),
  accountB = support.account(ACCOUNT_B),
  accountC = support.account(ACCOUNT_C),
  bothAccounts = [accountA, accountB],
  /* A store answering with what `accounts` hold, by source and directory. */
  holding = (accounts: readonly Account[]): typeof support.script =>
    Object.freeze({
      acquire: support.script.acquire,
      exchange: support.script.exchange,
      read: (source: string, configDir: Option.Option<string>) =>
        Effect.succeed(
          Option.fromUndefinedOr(
            accounts.find(
              (candidate) =>
                candidate.source === source &&
                Option.contains(configDir, candidate.configDir ?? ""),
            ),
          ).pipe(Option.map((candidate) => candidate.credentials)),
        ),
      writeBack: support.script.writeBack,
    }),
  /* The stores the rig was asked to read, in order. */
  readsSoFar = support.currentRig.pipe(
    Effect.flatMap((rig) => Ref.get(rig.reads)),
  ),
  /* A refresh rig whose store holds what `accounts` hold. */
  storeHolding = (
    accounts: readonly Account[],
  ): ReturnType<typeof refreshLayer> =>
    refreshLayer(holding(accounts), Option.none()),
  storeWithA = storeHolding([accountA]),
  storeWithBoth = storeHolding(bothAccounts),
  storeWithCAndA = storeHolding([accountC, accountA]),
  /* The source rotated since startup; the import takes what it holds now. */
  storeWithRotatedB = storeHolding([
    support.account(ACCOUNT_B, "rotated-access"),
  ])

describe("claude Code account form", () => {
  it.effect("builds a static account form only for multiple accounts", () =>
    Effect.sync(() => {
      expect.hasAssertions()
      expect(accountMethod.buildAccountForm([])).toStrictEqual(Option.none())
      expect(accountMethod.buildAccountForm([accountA])).toStrictEqual(
        Option.none(),
      )
      expect(accountMethod.buildAccountForm(bothAccounts)).toStrictEqual(
        Option.some([
          {
            key: "account",
            options: [
              { label: `Claude Pro: ${ACCOUNT_A}`, value: ACCOUNT_A },
              { label: `Claude Pro: ${ACCOUNT_B}`, value: ACCOUNT_B },
            ],
            required: true,
            title: "Claude Code account",
            type: "string",
          },
        ]),
      )
    }),
  )
})

describe("claude Code account import", () => {
  it.effect(
    "imports the selected account's current credentials with its startup label",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const credential = yield* accountMethod.authorize(
            [accountA, support.account(ACCOUNT_B, "two-access")],
            { account: ACCOUNT_B },
          ),
          fingerprint = yield* sources.tokenFingerprint("rotated-access")

        expect(yield* readsSoFar).toStrictEqual([
          [ACCOUNT_B, Option.some(`/claude/${ACCOUNT_B}`)],
        ])
        expect([
          credential.type,
          credential.methodID,
          credential.access,
        ]).toStrictEqual([
          "oauth",
          claudeCodeCredential.METHOD_ID,
          "rotated-access",
        ])
        expect(claudeCodeCredential.credentialLabel(credential)).toBe(
          `Claude Pro: ${ACCOUNT_B}`,
        )
        expect(claudeCodeCredential.readMetadata(credential)).toStrictEqual(
          Option.some({
            accountLabel: `Claude Pro: ${ACCOUNT_B}`,
            configDir: `/claude/${ACCOUNT_B}`,
            source: ACCOUNT_B,
            sourceTokenHash: fingerprint,
          }),
        )
        expect(JSON.stringify(credential.metadata)).not.toContain(
          "rotated-access",
        )
      }).pipe(Effect.provide(storeWithRotatedB)),
  )
})

describe("claude Code account that disappeared", () => {
  it.effect("fails closed when the selected account disappeared", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const exit = yield* Effect.exit(
        accountMethod.authorize(bothAccounts, { account: ACCOUNT_B }),
      )

      expect(Exit.isFailure(exit)).toBe(true)
      expect(String(exit)).toMatch(/no longer available/u)
    }).pipe(Effect.provide(storeWithA)),
  )
})

describe("claude Code account selection", () => {
  it.effect(
    "requires an explicit valid answer for a multiple-account form",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const missing = yield* Effect.exit(
            accountMethod.authorize(bothAccounts, {}),
          ),
          wrongType = yield* Effect.exit(
            accountMethod.authorize(bothAccounts, { account: true }),
          )

        expect(String(missing)).toMatch(/Select a registered/u)
        expect(String(wrongType)).toMatch(/Select a registered/u)
        expect(yield* readsSoFar).toStrictEqual([])
      }).pipe(Effect.provide(storeWithBoth)),
  )
})

describe("claude Code accounts added after registration", () => {
  it.effect("does not expose accounts added after registration", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const imported = yield* accountMethod.authorize([accountA], {})

      expect(
        claudeCodeCredential
          .readMetadata(imported)
          .pipe(Option.map((metadata) => metadata.source)),
      ).toStrictEqual(Option.some(ACCOUNT_A))
      expect(yield* readsSoFar).toStrictEqual([
        [ACCOUNT_A, Option.some(`/claude/${ACCOUNT_A}`)],
      ])
    }).pipe(Effect.provide(storeWithCAndA)),
  )
})
