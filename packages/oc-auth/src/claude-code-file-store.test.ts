import { Effect, FileSystem, Option, Schema } from "effect"
import type { Layer, Scope } from "effect"
import { expect, it as test } from "@effect/vitest"
import type { Vitest } from "@effect/vitest"
import files from "./claude-code-file-store.test-support.ts"
import support from "./claude-code-stores.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

/** The MCP data write-back must keep. */
const HeldMcp = Schema.Struct({
    server: Schema.Struct({ name: Schema.String }),
  }),
  /** What write-back must keep in the credentials file. */
  KeptFile = Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.Struct({
        accessToken: Schema.String,
        subscriptionType: Schema.String,
      }),
      mcpOAuth: HeldMcp,
    }),
  ),
  ONE_ASSERTION = 1,
  PERMISSION_MODULUS = 0o1000,
  PRIVATE_FILE = 0o600,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2

test.layer(support.layer)("credentials file reads", (it: Tests) => {
  it.effect(
    "reads an account's current credentials from the configured file",
    () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const empty = yield* support.sandbox,
          holder = yield* files.credentialDir("file-access"),
          reads = yield* support.onMac([], (stores) =>
            Effect.all({
              found: stores.readSource(files.FILE, Option.some(holder.dir)),
              missing: stores.readSource(files.FILE, Option.some(empty)),
            }),
          )

        expect(
          reads.found.pipe(
            Option.map((credentials) => credentials.accessToken),
          ),
        ).toStrictEqual(Option.some("file-access"))
        expect(Option.isNone(reads.missing)).toBe(true)
      }),
  )
})

test.layer(support.layer)("credentials file discovery", (it: Tests) => {
  it.effect("discovers the configured file source on non-macOS platforms", () =>
    Effect.gen(function* run() {
      expect.assertions(ONE_ASSERTION)

      const home = yield* support.sandbox,
        plain = yield* files.plainCredentialDir,
        seen = yield* support.withStores(
          { home, platform: "linux", variables: { CLAUDE_CONFIG_DIR: plain } },
          (stores) => stores.readAccounts,
        )

      expect(seen).toStrictEqual([
        {
          configDir: plain,
          credentials: {
            accessToken: "file-access",
            expiresAt: 2000,
            refreshToken: "file-refresh",
          },
          label: "Claude",
          source: files.FILE,
        },
      ])
    }),
  )
})

test.layer(support.layer)("guarded file write-back", (it: Tests) => {
  it.effect("updates the matching source and preserves unrelated data", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const fs = yield* FileSystem.FileSystem,
        holder = yield* files.credentialDir("old"),
        result = yield* support.onMac([], files.refreshFile(holder.dir)),
        written = yield* fs.readFileString(holder.path)

      expect(result).toBe("written")
      expect(Schema.decodeOption(KeptFile)(written)).toStrictEqual(
        Option.some({
          claudeAiOauth: { accessToken: "new", subscriptionType: "max" },
          mcpOAuth: { server: { name: "keep" } },
        }),
      )
      expect((yield* fs.stat(holder.path)).mode % PERMISSION_MODULUS).toBe(
        PRIVATE_FILE,
      )
    }),
  )
})

test.layer(support.layer)("guarded file write-back conflicts", (it: Tests) => {
  it.effect("reports a stale-token conflict without overwriting", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const holder = yield* files.credentialDir("winner"),
        result = yield* support.onMac([], files.refreshFile(holder.dir))

      expect(result).toBe("conflict")
      expect(yield* files.fileToken(holder.path)).toStrictEqual(
        Option.some("winner"),
      )
    }),
  )
})
