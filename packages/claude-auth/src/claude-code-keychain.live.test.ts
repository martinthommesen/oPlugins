/**
 * Write-back against the real `/usr/bin/security`, which the fake in
 * `fake-keychain.test-support.ts` can only imitate. A stub once hid a write
 * that stored an empty password and exited 0, so CI runs this on macOS.
 *
 * Opt-in with CLAUDE_AUTH_LIVE_KEYCHAIN=1: it adds throwaway items to the
 * default keychain (named like Claude Code's, with a random suffix no config
 * directory maps to) and deletes them again.
 */
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import {
  Config,
  Crypto,
  Effect,
  Encoding,
  Exit,
  Layer,
  Option,
  Schema,
} from "effect"
import { describe, expect, it } from "@effect/vitest"
import ClaudeCodeStores from "./claude-code-stores.ts"
import DebugLog from "./debug-log.ts"
import Environment from "./environment.ts"
import nodePlatform from "./node-platform.ts"

const ACCOUNT = String.raw`live "test" \ account`,
  EXIT_SUCCESS = 0,
  /** The MCP data padding a blob past one interactive line. */
  HeldPadding = Schema.Struct({
    server: Schema.Struct({ token: Schema.String }),
  }),
  ITEM_SUFFIX_BYTES = 8,
  /** What the live item holds after the write, as `security -w` prints it. */
  LiveBlob = Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.Struct({ note: Schema.String }),
      mcpOAuth: Schema.optionalKey(HeldPadding),
    }),
  ),
  NO_PADDING = 0,
  OLD_ACCESS = "live-old-access",
  /** The old tokens a throwaway item starts with. */
  OLD_TOKENS = {
    accessToken: "live-old-access",
    expiresAt: 1000,
    note: "ünïcode",
    refreshToken: "live-old-refresh",
  },
  PADDED_LENGTH = 6000,
  REFRESHED = {
    accessToken: "live-new-access",
    expiresAt: 4_000_000_000_000,
    refreshToken: "live-new-refresh",
  },
  SECURITY = "/usr/bin/security",
  TWO_ASSERTIONS = 2,
  /* The JSON a throwaway item holds, padded with `padding` characters. */
  blobFor = (padding: number): string => {
    if (padding === NO_PADDING) {
      return JSON.stringify({ claudeAiOauth: OLD_TOKENS })
    }

    return JSON.stringify({
      claudeAiOauth: OLD_TOKENS,
      mcpOAuth: { server: { token: "m".repeat(padding) } },
    })
  },
  /*
   * Whether this run opted in: macOS, with CLAUDE_AUTH_LIVE_KEYCHAIN=1. Read
   * through `Config` from the process environment, before any test runs.
   */
  enabled = Exit.match(
    Effect.runSyncExit(
      Effect.gen(function* liveRequested() {
        const flag = yield* Config.option(
          Config.string("CLAUDE_AUTH_LIVE_KEYCHAIN"),
        )

        return process.platform === "darwin" && Option.contains(flag, "1")
      }),
    ),
    { onFailure: () => false, onSuccess: (requested) => requested },
  ),
  /* The exit status of the real `security` tool run with `args`. */
  exitOf = Effect.fn("live.exitOf")(function* exitOf(args: readonly string[]) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

    return Number(yield* spawner.exitCode(ChildProcess.make(SECURITY, args)))
  }),
  /** The stores on this machine, with the real `security` tool. */
  layer = ClaudeCodeStores.layer.pipe(
    Layer.provideMerge(DebugLog.layer),
    Layer.provideMerge(Environment.layer),
    Layer.provideMerge(nodePlatform),
  ),
  /* Run the real `security` tool with `args`, which must succeed. */
  mustSucceed = Effect.fn("live.mustSucceed")(
    function* mustSucceed(args: readonly string[]) {
      const status = yield* exitOf(args)

      if (status !== EXIT_SUCCESS) {
        return yield* Effect.die(`security ${args[NO_PADDING] ?? ""} failed`)
      }

      return status
    },
    (effect) => Effect.orDie(effect),
  ),
  /* A service name like Claude Code's, with a suffix no config directory maps to. */
  newItemName = Effect.gen(function* newItemName() {
    const platformCrypto = yield* Crypto.Crypto,
      suffix = yield* platformCrypto.randomBytes(ITEM_SUFFIX_BYTES)

    return `Claude Code-credentials-${Encoding.encodeHex(suffix)}`
  }),
  /* Write back over `item`, then read what it holds through both paths. */
  observe = Effect.fn("live.observe")(function* observe(item: string) {
    const accounts = yield* ClaudeCodeStores,
      result = yield* accounts.writeBack({
        configDir: Option.none(),
        credentials: REFRESHED,
        expectedAccessToken: OLD_ACCESS,
        source: item,
      }),
      spawner = yield* ChildProcessSpawner.ChildProcessSpawner,
      stored = yield* accounts.readSource(item, Option.none()),
      verbatim = yield* spawner.string(
        ChildProcess.make(SECURITY, [
          "find-generic-password",
          "-s",
          item,
          "-w",
        ]),
      ),
      written = yield* Schema.decodeUnknownEffect(LiveBlob)(verbatim.trim())

    return {
      note: written.claudeAiOauth.note,
      padding: Option.fromUndefinedOr(written.mcpOAuth).pipe(
        Option.map((mcp) => mcp.server.token.length),
      ),
      result,
      tokens: stored.pipe(
        Option.map((found) => [found.accessToken, found.refreshToken]),
      ),
    }
  }),
  /*
   * Create a throwaway item padded with `padding` characters, write back
   * over it, then delete it. `remaining` is the exit status of looking it up
   * once deleted: write-back must update the item, not add a second one.
   */
  runLive = Effect.fn("live.run")(function* runLive(padding: number) {
    const hex = Encoding.encodeHex(blobFor(padding)),
      item = yield* newItemName,
      observed = yield* Effect.acquireUseRelease(
        mustSucceed([
          "add-generic-password",
          "-s",
          item,
          "-a",
          ACCOUNT,
          "-X",
          hex,
        ]),
        () => observe(item),
        () => mustSucceed(["delete-generic-password", "-s", item]),
      ),
      remaining = yield* exitOf(["find-generic-password", "-s", item])

    return { observed, remaining }
  })

describe.runIf(enabled)("write-back through the real security tool", () => {
  it.live("stores the full blob when it fits one interactive line", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      const outcome = yield* runLive(NO_PADDING)

      expect(outcome.observed).toStrictEqual({
        note: "ünïcode",
        padding: Option.none(),
        result: "written",
        tokens: Option.some(["live-new-access", "live-new-refresh"]),
      })
      expect(outcome.remaining).not.toBe(EXIT_SUCCESS)
    }).pipe(Effect.provide(layer)),
  )

  it.live(
    "stores the full blob when it is too long for one interactive line",
    () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const outcome = yield* runLive(PADDED_LENGTH)

        expect(outcome.observed).toStrictEqual({
          note: "ünïcode",
          padding: Option.some(PADDED_LENGTH),
          result: "written",
          tokens: Option.some(["live-new-access", "live-new-refresh"]),
        })
        expect(outcome.remaining).not.toBe(EXIT_SUCCESS)
      }).pipe(Effect.provide(layer)),
  )
})
