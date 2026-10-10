import type { Config, Path, Stdio } from "effect"
import { Context, Effect, FileSystem, Layer, Schema } from "effect"
import { NodeFileSystem, NodePath } from "@effect/platform-node-shared"
import CapturedStderr from "./captured-stderr.test-support.ts"
import DebugLog from "./debug-log.ts"
import testEnvironment from "./test-environment.test-support.ts"

const LogRecord = Schema.fromJsonString(
    Schema.Struct({
      directory: Schema.optionalKey(Schema.String),
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

    return yield* fs.makeTempDirectoryScoped({ prefix: "obrowse-log-" })
  }),
  /*
   * Start a logger whose home and data directory are `home`, with
   * `OBROWSE_DEBUG` set to `debug` unless it is empty, and run `body`
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
          ...[["OBROWSE_DEBUG", debug] as const].filter(
            ([, value]: readonly [string, string]) => value !== "",
          ),
        ]),
      ),
      logger = DebugLog.layer.pipe(Layer.provide(environment))

    return Layer.build(logger).pipe(
      Effect.flatMap((context) => body(Context.get(context, DebugLog))),
      Effect.scoped,
    )
  }

/** What the debug-log tests share. */
export default Object.freeze({
  layer: Layer.mergeAll(platform, CapturedStderr.layer),
  readRecords,
  sandbox,
  withLogger,
})
