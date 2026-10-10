import type { Config, Path, Stdio } from "effect"
import { Effect, FileSystem, Layer, Schema } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import CapturedStderr from "./captured-stderr.test-support.ts"
import DebugLog from "./debug-log.ts"
import testEnvironment from "./test-environment.test-support.ts"

const LogRecord = Schema.fromJsonString(
    Schema.Struct({
      event: Schema.String,
      key: Schema.optionalKey(Schema.String),
      source: Schema.optionalKey(Schema.String),
      ts: Schema.String,
      warning: Schema.optionalKey(Schema.String),
    }),
  ),
  /** Node's file system and paths, for tests that touch real files. */
  platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer),
  /* The decoded records in the log at `path`. */
  readRecords = Effect.fn("test.readRecords")(function* readRecords(
    path: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      text = yield* fs.readFileString(path)

    return yield* Effect.forEach(text.trim().split("\n"), (line) =>
      Schema.decodeUnknownEffect(LogRecord)(line),
    )
  }),
  /* A scoped temporary directory standing in for the user's home. */
  sandbox = Effect.gen(function* makeSandbox() {
    const fs = yield* FileSystem.FileSystem

    return yield* fs.makeTempDirectoryScoped({ prefix: "claude-auth-log-" })
  }),
  /*
   * Start a logger whose home and data directory are `home`, with
   * `CLAUDE_AUTH_DEBUG` set to `debug` unless it is empty, and run `body`
   * against it.
   */
  withLogger = <Value, Failure>(
    home: string,
    debug: string,
    body: (logger: DebugLog["Service"]) => Effect.Effect<Value, Failure>,
  ): Effect.Effect<
    Value,
    Failure | Config.ConfigError,
    FileSystem.FileSystem | Path.Path | Stdio.Stdio
  > => {
    const environment = testEnvironment(
        Object.fromEntries([
          ["HOME", home],
          ["XDG_DATA_HOME", home],
          ...[["CLAUDE_AUTH_DEBUG", debug] as const].filter(
            ([, value]: readonly [string, string]) => value !== "",
          ),
        ]),
      ),
      logger = DebugLog.layer.pipe(Layer.provide(environment))

    return Effect.gen(function* run() {
      return yield* body(yield* DebugLog)
    }).pipe(Effect.provide(logger))
  }

/** What the debug-log tests share. */
export default Object.freeze({
  layer: Layer.mergeAll(platform, CapturedStderr.layer),
  readRecords,
  sandbox,
  withLogger,
})
