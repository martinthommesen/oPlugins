import type { Config, Crypto, Path, Stdio } from "effect"
import { Context, Effect, FileSystem, Layer, Option, Schema } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import CapturedStderr from "./captured-stderr.test-support.ts"
import type { ChildProcessSpawner } from "effect/unstable/process"
import ClaudeCodeStores from "./claude-code-stores.ts"
import DebugLog from "./debug-log.ts"
import FakeKeychain from "./fake-keychain.test-support.ts"
import testEnvironment from "./test-environment.test-support.ts"

type Stores = ClaudeCodeStores["Service"]

type WriteBackRequest = Parameters<Stores["writeBack"]>[typeof FIRST]

/** The machine a test runs the stores on. */
interface Machine {
  readonly home: string
  readonly platform: string
  readonly variables: Readonly<Record<string, string>>
}

const FIRST = 0,
  /** The access token a stored blob carries, wrapped as Claude Code writes it. */
  StoredToken = Schema.fromJsonString(
    Schema.Struct({
      claudeAiOauth: Schema.Struct({ accessToken: Schema.String }),
    }),
  ),
  /* The access token in `blob`, or none when it holds none. */
  accessTokenIn = (blob: Option.Option<string>): Option.Option<string> =>
    blob.pipe(
      Option.flatMap((text) => Schema.decodeOption(StoredToken)(text)),
      Option.map((stored) => stored.claudeAiOauth.accessToken),
    ),
  /* A credential blob as Claude Code stores it. */
  credentialBlob = (accessToken: string): string =>
    JSON.stringify({
      claudeAiOauth: {
        accessToken,
        expiresAt: 2000,
        refreshToken: `${accessToken}-refresh`,
        subscriptionType: "pro",
      },
    }),
  /** Platform services, captured stderr, and the fake Keychain. */
  layer = Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    NodeCrypto.layer,
    CapturedStderr.layer,
    FakeKeychain.layer,
  ),
  /* Refreshed tokens, written back over a store that held `expected`. */
  refresh = (
    source: string,
    expected: string,
    configDir: Option.Option<string>,
  ): WriteBackRequest => ({
    configDir,
    credentials: { accessToken: "new", expiresAt: 3000, refreshToken: "r" },
    expectedAccessToken: expected,
    source,
  }),
  /* A scoped temporary directory. */
  sandbox = Effect.gen(function* makeSandbox() {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.makeTempDirectoryScoped({ prefix: "claude-auth-stores-" })
  }),
  /*
   * Run `body` against the stores of `machine`: its home directory, its
   * platform, and its environment variables.
   */
  withStores = <Value, Failure>(
    machine: Machine,
    body: (stores: Stores) => Effect.Effect<Value, Failure>,
  ): Effect.Effect<
    Value,
    Config.ConfigError | Failure,
    | ChildProcessSpawner.ChildProcessSpawner
    | Crypto.Crypto
    | FileSystem.FileSystem
    | Path.Path
    | Stdio.Stdio
  > => {
    const environment = testEnvironment(
        Object.fromEntries([
          ["HOME", machine.home],
          ...Object.entries(machine.variables),
        ]),
      )(machine.platform),
      stores = ClaudeCodeStores.layer.pipe(
        Layer.provide(DebugLog.layer),
        Layer.provide(environment),
      )

    return Layer.build(stores).pipe(
      Effect.flatMap((context) => body(Context.get(context, ClaudeCodeStores))),
      Effect.scoped,
    )
  },
  /*
   * Seed the fake Keychain with `entries`, then run `body` against the stores
   * of a macOS machine with a fresh home directory.
   */
  withStoresOnMac = Effect.fn("test.onMac")(function* withStoresOnMac<
    Value,
    Failure,
  >(
    entries: readonly (readonly [string, string])[],
    body: (stores: Stores) => Effect.Effect<Value, Failure>,
  ) {
    const home = yield* sandbox,
      keychain = yield* FakeKeychain

    yield* Effect.forEach(
      entries,
      ([name, content]) => keychain.write(name, content),
      { discard: true },
    )

    return yield* withStores({ home, platform: "darwin", variables: {} }, body)
  })

/** What the credential-store tests share. */
export default Object.freeze({
  accessTokenIn,
  credentialBlob,
  layer,
  onMac: withStoresOnMac,
  refresh,
  sandbox,
  withStores,
})
