import { Array as Arr, Effect, FileSystem, Option, Path, Schema } from "effect"

import DebugLogPathError from "./debug-log-path-error.ts"
import Environment from "./environment.ts"
import type { PlatformError } from "effect"
import opencodeDataDir from "./opencode-data-dir.ts"

const DEFAULT_LOG_NAME = "oclaude-debug.log",
  DISABLED_VALUES = new Set(["0", "false", "no", "off"]),
  ENABLED_VALUES = new Set(["1", "true", "yes", "on"]),
  /* A bounded prefix: the first record identifies the file, and an existing log can be large. */
  IDENTIFYING_PREFIX_BYTES = 4096,
  LogRecord = Schema.fromJsonString(
    Schema.Struct({ event: Schema.String, ts: Schema.String }),
  ),
  PRIVATE_DIRECTORY = 0o700,
  PRIVATE_FILE = 0o600,
  decoder = new TextDecoder(),
  /* The start of the file at `path`, as text. */
  filePrefix = Effect.fn("DebugLog.filePrefix")(function* filePrefix(
    path: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      handle = yield* fs.open(path, { flag: "r" }),
      prefix = yield* handle.readAlloc(IDENTIFYING_PREFIX_BYTES)

    return decoder.decode(Option.getOrElse(prefix, () => new Uint8Array()))
  }, Effect.scoped),
  /*
   * Whether the existing file at `path` was written by this logger: empty, or
   * starting with one of its records. A file that cannot be read is not.
   */
  isOwnLog = (
    path: string,
  ): Effect.Effect<boolean, never, FileSystem.FileSystem> =>
    filePrefix(path).pipe(
      Effect.map(
        (text) =>
          text.trim() === "" ||
          Option.exists(Arr.head(text.split("\n")), (line) =>
            Option.isSome(Schema.decodeUnknownOption(LogRecord)(line)),
          ),
      ),
      Effect.orElseSucceed(() => false),
    ),
  /* Whether `path` holds a file this logger did not write. */
  notOwnLog = (
    path: string,
  ): Effect.Effect<
    boolean,
    PlatformError.PlatformError,
    FileSystem.FileSystem
  > =>
    Effect.gen(function* checkOwner() {
      const fs = yield* FileSystem.FileSystem

      return (yield* fs.exists(path)) && !(yield* isOwnLog(path))
    }),
  /*
   * The log file `CLAUDE_AUTH_DEBUG` names, or none when logging is off. A
   * non-boolean value is a literal path, which must be absolute.
   */
  resolveLogPath = Effect.fn("DebugLog.resolveLogPath")(function* resolve() {
    const environment = yield* Environment,
      path = yield* Path.Path,
      raw = Option.getOrElse(environment.variables.debug, () => "").trim(),
      setting = raw.toLowerCase()

    if (raw === "" || DISABLED_VALUES.has(setting)) {
      return Option.none<string>()
    }

    if (ENABLED_VALUES.has(setting)) {
      return Option.some(path.join(yield* opencodeDataDir, DEFAULT_LOG_NAME))
    }

    if (!path.isAbsolute(raw)) {
      return yield* new DebugLogPathError({
        message: `CLAUDE_AUTH_DEBUG must be 1 or an absolute log file path (got "${raw}")`,
      })
    }

    return Option.some(raw)
  }),
  /*
   * Start a fresh log at `path`. Every service start truncates the log, so
   * `CLAUDE_AUTH_DEBUG` could empty any file the user can write. Rather than
   * blocklist filenames, this refuses to overwrite any existing file that is
   * not already one of these logs: `.credentials.json`, `auth.json`, `.env`,
   * and every file nobody has thought of yet. The log names accounts and
   * config paths, so it is kept as private as the credentials it describes.
   */
  startLog = Effect.fn("DebugLog.startLog")(function* startLog(path: string) {
    const environment = yield* Environment,
      fs = yield* FileSystem.FileSystem,
      paths = yield* Path.Path,
      refusal = new DebugLogPathError({
        message: `CLAUDE_AUTH_DEBUG refuses to truncate "${path}": it is not an oClaude log`,
      })

    yield* fs.makeDirectory(paths.dirname(path), {
      mode: PRIVATE_DIRECTORY,
      recursive: true,
    })
    yield* Effect.fail(refusal).pipe(Effect.when(notOwnLog(path)))
    yield* fs.writeFileString(path, "", { mode: PRIVATE_FILE })
    yield* fs
      .chmod(path, PRIVATE_FILE)
      .pipe(
        Effect.when(Effect.succeed(environment.process.platform !== "win32")),
      )
  })

/** Resolving and preparing the debug log, in the order startup needs. */
export default Object.freeze({ resolveLogPath, startLog })
