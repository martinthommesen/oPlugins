import { Effect, FileSystem, Path } from "effect"
import type { Layer, PlatformError, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Vitest } from "@effect/vitest"
import support from "./claude-code-stores.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

/** Sets up the `.claude.json` at the path it is given. */
type Placement = (
  accountFile: string,
) => Effect.Effect<void, PlatformError.PlatformError, FileSystem.FileSystem>

const UNLABELED = "Claude Pro",
  /* What the account file holds: `text`. */
  holding =
    (text: string): Placement =>
    (accountFile) =>
      FileSystem.FileSystem.pipe(
        Effect.flatMap((fs) => fs.writeFileString(accountFile, text)),
      ),
  /*
   * The label of the file account on a Linux machine whose home-level
   * `.claude.json` `place` sets up. The config directory holds no
   * `.claude.json`, so every read also finds one file missing.
   */
  labelWith = Effect.fn("test.labelWith")(function* labelWith(
    place: Placement,
  ) {
    const fs = yield* FileSystem.FileSystem,
      home = yield* support.sandbox,
      path = yield* Path.Path,
      primaryDir = path.join(home, ".claude")

    yield* fs.makeDirectory(primaryDir)
    yield* fs.writeFileString(
      path.join(primaryDir, ".credentials.json"),
      support.credentialBlob("one-access"),
    )
    yield* place(path.join(home, ".claude.json"))

    return yield* support.withStores(
      { home, platform: "linux", variables: {} },
      (stores) =>
        stores.readAccounts.pipe(
          Effect.map((accounts) => accounts.map((account) => account.label)),
        ),
    )
  }),
  /* No `.claude.json` at all. */
  missing: Placement = () => Effect.void,
  /* Each record logged about account files: level, event, field names. */
  reported = CapturedLogs.pipe(
    Effect.flatMap((logs) => logs.records),
    Effect.map((records) =>
      records
        .filter((record) => record.message.startsWith("account_file_"))
        .map((record) => [
          record.level,
          record.message,
          Object.keys(record.annotations),
        ]),
    ),
  ),
  /* A directory where the file should be, which no read gets through. */
  unreadable: Placement = (accountFile) =>
    FileSystem.FileSystem.pipe(
      Effect.flatMap((fs) => fs.makeDirectory(accountFile)),
    )

describe("account labels from a readable account file", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("labels the account with the email the file names", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const label = yield* labelWith(
          holding('{"oauthAccount":{"emailAddress":"one@example.com"}}'),
        )

        expect(label).toStrictEqual([`${UNLABELED}: one@example.com`])
        expect(yield* reported).toStrictEqual([])
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("stays quiet about a missing file", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        expect(yield* labelWith(missing)).toStrictEqual([UNLABELED])
        expect(yield* reported).toStrictEqual([])
      }),
    )
  })
})

describe("account labels from a file without an account", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("stays quiet about a file that names no account", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const label = yield* labelWith(holding('{"numStartups":3}'))

        expect(label).toStrictEqual([UNLABELED])
        expect(yield* reported).toStrictEqual([])
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("stays quiet about an account without an email", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const label = yield* labelWith(
          holding('{"oauthAccount":{"accountUuid":"uuid"}}'),
        )

        expect(label).toStrictEqual([UNLABELED])
        expect(yield* reported).toStrictEqual([])
      }),
    )
  })
})

describe("account labels from a malformed account file", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("warns about a file that is not JSON, without its content", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        expect(yield* labelWith(holding("{not json"))).toStrictEqual([
          UNLABELED,
        ])
        // The parser's message quotes the file, so only its path is kept.
        expect(yield* reported).toStrictEqual([
          ["Warn", "account_file_malformed", []],
          ["Debug", "account_file_malformed", ["path"]],
        ])
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("warns about an email that is not a string", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const label = yield* labelWith(
          holding('{"oauthAccount":{"emailAddress":42}}'),
        )

        expect(label).toStrictEqual([UNLABELED])
        expect(yield* reported).toStrictEqual([
          ["Warn", "account_file_malformed", []],
          ["Debug", "account_file_malformed", ["path"]],
        ])
      }),
    )
  })
})

describe("account labels from an unreadable account file", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect(
      "warns about a file it cannot read, apart from a missing one",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          expect(yield* labelWith(unreadable)).toStrictEqual([UNLABELED])
          expect(yield* reported).toStrictEqual([
            ["Warn", "account_file_unreadable", []],
            ["Debug", "account_file_unreadable", ["error", "path"]],
          ])
        }),
    )
  })
})
