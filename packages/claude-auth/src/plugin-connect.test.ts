import { Effect, Exit, Match, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import ClaudeCodeStoreError from "./claude-code-store-error.ts"
import FakeIntegration from "./fake-integration.test-support.ts"
import PluginRig from "./plugin-rig.test-support.ts"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"

type Script = typeof PluginRig.quiet

type Credential = ReturnType<typeof scenario.imported>

/*
 * Real Keychain service names: credential metadata is validated on the way
 * back in, so a fixture using an arbitrary name would not round-trip.
 */
const ACCOUNT_A = "Claude Code-credentials-aaaaaaaa",
  ACCOUNT_B = "Claude Code-credentials-bbbbbbbb",
  /** The method registered for two accounts: auto import, with a picker. */
  CONNECT_METHOD = {
    form: [
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
    ],
    id: "claude-code",
    label: "Import Claude Code subscription",
    type: "oauth",
  },
  /* A healthy script whose stores and refresh answer as given. */
  answering = (
    accounts: Script["accounts"],
    refresh: Script["refresh"] = PluginRig.quiet.refresh,
  ): Script =>
    Object.freeze({
      accounts,
      adopt: PluginRig.quiet.adopt,
      fetch: PluginRig.quiet.fetch,
      refresh,
    }),
  /* What the host's refresh callback returns for the credential holding `access`. */
  hostRefreshes = (
    access: string,
  ): Effect.Effect<Credential, unknown, FakeIntegration> =>
    FakeIntegration.pipe(
      Effect.flatMap((integration) => integration.method),
      Effect.flatMap((method) =>
        Effect.fromOption(Option.fromUndefinedOr(method.refresh)),
      ),
      Effect.flatMap((refresh) => refresh(scenario.imported(access))),
    ),
  /* The credential an authorization hands the host, for an automatic one. */
  importedBy = Effect.fn("test.importedBy")(function* importedBy(
    answer: Readonly<Record<string, string>>,
  ) {
    const method = yield* (yield* FakeIntegration).method,
      offer = yield* method.authorize(answer)

    return yield* Match.value(offer).pipe(
      Match.when({ mode: "auto" }, (automatic) => automatic.callback),
      Match.orElse(() => Effect.die("expected an automatic authorization")),
    )
  }),
  /* The access token and label of the account the user picked by `answer`. */
  importedWithLabel = Effect.fn("test.importedWithLabel")(
    function* importedWithLabel(answer: Readonly<Record<string, string>>) {
      const credential = yield* importedBy(answer),
        method = yield* (yield* FakeIntegration).method

      return {
        access: credential.access,
        label: Option.fromUndefinedOr(method.label).pipe(
          Option.flatMapNullishOr((label) => label(credential)),
        ),
      }
    },
  ),
  keychainLocked = Effect.fail(
    new ClaudeCodeStoreError({ message: "macOS Keychain is locked" }),
  ),
  lockedKeychain = scenario.onHost(Option.none(), answering(keychainLocked)),
  refreshingHost = scenario.onHost(
    scenario.ours("first"),
    answering(Effect.succeed([]), () =>
      Effect.succeed(scenario.refreshed("second")),
    ),
  ),
  twoAccounts = [
    scenario.account(ACCOUNT_A, "one-access"),
    scenario.account(ACCOUNT_B, "two-access"),
  ],
  withAccounts = scenario.onHost(
    Option.none(),
    answering(Effect.succeed(twoAccounts)),
    twoAccounts,
  )

describe("the /connect method", () => {
  it.effect("registers the exact auto authorization method", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* fakeHost.setUp

      const method = yield* (yield* FakeIntegration).method

      expect([method.integrationID, method.method]).toStrictEqual([
        "anthropic",
        CONNECT_METHOD,
      ])
    }).pipe(Effect.provide(withAccounts)),
  )

  it.effect("imports the selected account with its persisted label", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()
      yield* fakeHost.setUp

      expect(yield* importedWithLabel({ account: ACCOUNT_B })).toStrictEqual({
        access: "two-access",
        label: Option.some(`Claude Pro: ${ACCOUNT_B}`),
      })
    }).pipe(Effect.provide(withAccounts)),
  )

  it.effect(
    "reports a startup discovery failure from /connect instead of 'no credentials'",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const attempt = yield* Effect.exit(importedBy({}))

        expect(Exit.isFailure(attempt)).toBe(true)
        expect(String(attempt)).toMatch(/Keychain is locked/u)
      }).pipe(Effect.provide(lockedKeychain)),
  )
})

describe("the host's refresh callback", () => {
  it.effect(
    "keeps the host refresh callback and the request path in step",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        yield* fakeHost.setUp

        const returned = yield* hostRefreshes("first"),
          sentAfter = yield* scenario.send(scenario.messages())

        expect(returned.access).toBe("second")
        // The request path must use the credential the host just refreshed.
        expect(sentAfter.headers.get("authorization")).toBe("Bearer second")
      }).pipe(Effect.provide(refreshingHost)),
  )
})
