import { Effect, FileSystem, Option, Path, Schema } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "./captured-logs.test-support.ts"
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

// The account file Claude Code keeps in a config directory.
const AccountFile = Schema.fromJsonString(
    Schema.Struct({
      oauthAccount: Schema.Struct({ emailAddress: Schema.String }),
    }),
  ),
  LOCKABLE_ITEM = `${sources.PRIMARY_SERVICE}-0123abcd`,
  /** A locked primary item beside a readable suffixed one. */
  LOCKED_PRIMARY = [
    [`${sources.PRIMARY_SERVICE}.exit`, "36"],
    [LOCKABLE_ITEM, support.credentialBlob("two-access")],
    ["dump", `"${sources.PRIMARY_SERVICE}"\n"${LOCKABLE_ITEM}"\n`],
  ] as const,
  NOTED_BLOB = JSON.stringify({
    claudeAiOauth: {
      accessToken: "current",
      expiresAt: 2000,
      note: "ünïcode",
      refreshToken: "current-refresh",
    },
  }),
  ONE_ASSERTION = 1,
  OTHER_APP = "Some Other App",
  PRIMARY = sources.PRIMARY_SERVICE,
  TWO_ASSERTIONS = 2,
  /* A config directory under `home` whose account file names `email`. */
  configDirWith = Effect.fn("test.configDirWith")(function* configDirWith(
    home: string,
    name: string,
    email: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      target = path.join(home, name)

    yield* fs.makeDirectory(target)
    yield* fs.writeFileString(
      path.join(target, ".claude.json"),
      yield* Schema.encodeEffect(AccountFile)({
        oauthAccount: { emailAddress: email },
      }),
    )

    return target
  }),
  /*
   * Two Pro accounts: the primary item for `~/.claude` and a suffixed one for
   * `~/.work`, listed suffixed first. What discovery should report for them.
   */
  twoAccountMachine = Effect.fn("test.twoAccountMachine")(
    function* twoAccountMachine(home: string) {
      const keychain = yield* FakeKeychain,
        primaryDir = yield* configDirWith(home, ".claude", "one@example.com"),
        workDir = yield* configDirWith(home, ".work", "two@example.com"),
        workItem = `${PRIMARY}-${yield* sources.keychainSuffixForDir(workDir)}`

      yield* keychain.write(PRIMARY, support.credentialBlob("one-access"))
      yield* keychain.write(workItem, support.credentialBlob("two-access"))
      yield* keychain.write("dump", `"${workItem}"\n"${PRIMARY}"\n`)

      return [
        ["Claude Pro 1: one@example.com", PRIMARY, primaryDir, "one-access"],
        ["Claude Pro 2: two@example.com", workItem, workDir, "two-access"],
      ]
    },
  )

describe("keychain account discovery", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("discovers and labels multiple accounts", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const home = yield* support.sandbox,
          machine = yield* twoAccountMachine(home),
          seen = yield* support.withStores(
            { home, platform: "darwin", variables: {} },
            (stores) => stores.readAccounts,
          )

        expect(
          seen.map((account) => [
            account.label,
            account.source,
            account.configDir,
            account.credentials.accessToken,
          ]),
        ).toStrictEqual(machine)
      }),
    )
  })
})

test.layer(support.layer)(
  "keychain account discovery that cannot list",
  (it: Tests) => {
    it.effect(
      "falls back to the primary item and says so when listing fails",
      () =>
        Effect.gen(function* run() {
          expect.assertions(TWO_ASSERTIONS)

          // No dump, so dump-keychain exits non-zero.
          const accounts = yield* support.onMac(
              [[PRIMARY, support.credentialBlob("one-access")]],
              (stores) => stores.readAccounts,
            ),
            warnings = (yield* (yield* CapturedLogs).records).filter(
              (record) => record.level === "Warn",
            )

          expect(accounts.map((found) => found.source)).toStrictEqual([PRIMARY])
          // Metadata only: the kind of failure, not its message.
          expect(
            warnings.map((record) => [
              record.message,
              Object.keys(record.annotations),
            ]),
          ).toStrictEqual([["keychain_list_failed", ["errorType"]]])
        }),
    )
  },
)

test.layer(support.layer)(
  "keychain account discovery with a locked item",
  (it: Tests) => {
    it.effect(
      "skips an inaccessible entry and reports it only when nothing loads",
      () =>
        Effect.gen(function* run() {
          expect.assertions(TWO_ASSERTIONS)

          const accounts = yield* support.onMac(
              LOCKED_PRIMARY,
              (stores) => stores.readAccounts,
            ),
            keychain = yield* FakeKeychain,
            relocked = yield* keychain
              .write(`${LOCKABLE_ITEM}.exit`, "36")
              .pipe(
                Effect.andThen(
                  support.onMac([], (stores) =>
                    Effect.flip(stores.readAccounts),
                  ),
                ),
              )

          expect(accounts.map((account) => account.source)).toStrictEqual([
            LOCKABLE_ITEM,
          ])
          expect(relocked.message).toMatch(/Keychain is locked/u)
        }),
    )
  },
)

test.layer(support.layer)("keychain source reads", (it: Tests) => {
  it.effect("reads an account's current credentials through the Keychain", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const [current, missing] = yield* support.onMac(
        [[PRIMARY, support.credentialBlob("current")]],
        (stores) =>
          Effect.all([
            stores.readSource(PRIMARY, Option.none()),
            stores.readSource(`${PRIMARY}-deadbeef`, Option.none()),
          ]),
      )

      expect(
        current.pipe(
          Option.map((found) => [found.accessToken, found.refreshToken]),
        ),
      ).toStrictEqual(Option.some(["current", "current-refresh"]))
      expect(Option.isNone(missing)).toBe(true)
    }),
  )
})

describe("keychain source reads of non-ASCII blobs", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("reads an item whose blob holds non-ASCII text", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const credentials = yield* support.onMac(
          [[PRIMARY, NOTED_BLOB]],
          (stores) => stores.readSource(PRIMARY, Option.none()),
        )

        expect(
          credentials.pipe(Option.map((found) => found.accessToken)),
        ).toStrictEqual(Option.some("current"))
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("will not read a source that is not a Claude Code item", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const credentials = yield* support.onMac(
            [[OTHER_APP, support.credentialBlob("theirs")]],
            (stores) => stores.readSource(OTHER_APP, Option.none()),
          ),
          keychain = yield* FakeKeychain

        expect(Option.isNone(credentials)).toBe(true)
        expect(yield* keychain.argv).toStrictEqual([])
      }),
    )
  })
})
