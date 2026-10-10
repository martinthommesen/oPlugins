import { Effect, FileSystem, Option, Path } from "effect"
import type ClaudeCodeStores from "./claude-code-stores.ts"
import { TestClock } from "effect/testing"
import support from "./claude-code-stores.test-support.ts"

type Stores = ClaudeCodeStores["Service"]

const FILE = "file",
  FRESH_TEMP_AGE_MS = 1_800_000,
  /** The time the sweep test's clock reads: three hours after the epoch. */
  NOW_MS = 10_800_000,
  SHARED_FILE = 0o644,
  STALE_TEMP_AGE_MS = 7_200_000,
  /* An empty file at `path`, last modified `ageMs` before `NOW_MS`. */
  agedFile = Effect.fn("test.agedFile")(function* agedFile(
    path: string,
    ageMs: number,
  ) {
    const fs = yield* FileSystem.FileSystem,
      stamp = new Date(NOW_MS - ageMs)

    yield* fs.writeFileString(path, "")
    yield* fs.utimes(path, stamp, stamp)
  }),
  /*
   * Three files in `dir`, with the clock at three hours: a temp blob two
   * hours old, a temp blob half an hour old, and an unrelated file two
   * hours old.
   */
  agedTemps = Effect.fn("test.agedTemps")(function* agedTemps(dir: string) {
    const path = yield* Path.Path,
      temps = [
        [path.join(dir, ".credentials.json.1.stale.tmp"), STALE_TEMP_AGE_MS],
        [path.join(dir, ".credentials.json.2.fresh.tmp"), FRESH_TEMP_AGE_MS],
        [path.join(dir, "notes.tmp"), STALE_TEMP_AGE_MS],
      ] as const

    yield* TestClock.setTime(NOW_MS)
    yield* Effect.forEach(temps, ([temp, age]) => agedFile(temp, age), {
      discard: true,
    })

    return temps.map(([temp]) => temp)
  }),
  /*
   * A config directory holding a credentials file with `accessToken`, extra
   * MCP data, and permissions other users can read.
   */
  credentialDir = Effect.fn("test.credentialDir")(function* credentialDir(
    accessToken: string,
  ) {
    const dir = yield* support.sandbox,
      fs = yield* FileSystem.FileSystem,
      path = (yield* Path.Path).join(dir, ".credentials.json")

    yield* fs.writeFileString(
      path,
      JSON.stringify({
        claudeAiOauth: {
          accessToken,
          expiresAt: 1000,
          refreshToken: "old-refresh",
          subscriptionType: "max",
        },
        mcpOAuth: { server: { name: "keep" } },
      }),
    )
    yield* fs.chmod(path, SHARED_FILE)

    return { dir, path }
  }),
  /* The access token in the file at `path`. */
  fileToken = Effect.fn("test.fileToken")(function* fileToken(path: string) {
    const fs = yield* FileSystem.FileSystem

    return support.accessTokenIn(Option.some(yield* fs.readFileString(path)))
  }),
  /* A config directory holding credentials without a subscription type. */
  plainCredentialDir = Effect.gen(function* plainCredentialDir() {
    const dir = yield* support.sandbox,
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path

    yield* fs.writeFileString(
      path.join(dir, ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: {
          accessToken: "file-access",
          expiresAt: 2000,
          refreshToken: "file-refresh",
        },
      }),
    )

    return dir
  }),
  /* Write refreshed tokens over the credentials file in `dir`, which held `old`. */
  refreshFile = (
    dir: string,
  ): ((stores: Stores) => ReturnType<Stores["writeBack"]>) => {
    const request = support.refresh(FILE, "old", Option.some(dir))

    return (stores) => stores.writeBack(request)
  }

/** What the credentials-file tests share. */
export default Object.freeze({
  FILE,
  agedTemps,
  credentialDir,
  fileToken,
  plainCredentialDir,
  refreshFile,
})
