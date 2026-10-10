import { Clock, Crypto, Effect, FileSystem, Option, Path, Schema } from "effect"
import ClaudeCodeStoreError from "./claude-code-store-error.ts"
import Environment from "./environment.ts"
import sources from "./claude-code-sources.ts"

/** The parts of a platform failure this store reports or decides on. */
interface FileFailure {
  readonly cause?: unknown
  readonly message: string
}

const CREDENTIALS_FILE = ".credentials.json",
  /** The errno code Node attaches to a failed file operation. */
  Errno = Schema.Struct({ code: Schema.String }),
  /** Codes that mean nothing is stored, rather than an unreadable store. */
  MISSING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]),
  PRIVATE_FILE = 0o600,
  TEMP_PREFIX = ".credentials.json.",
  TEMP_SUFFIX = ".tmp",
  TEMP_SWEEP_AGE_MS = 3_600_000,
  codec = new TextEncoder(),
  /* The errno code of `failure`, when it carries one. */
  errnoOf = (failure: FileFailure): Option.Option<string> =>
    Schema.decodeUnknownOption(Errno)(failure.cause).pipe(
      Option.map((errno) => errno.code),
    ),
  /* `failure` as the store error the user sees, with its errno code. */
  failedFile = (failure: FileFailure): ClaudeCodeStoreError =>
    new ClaudeCodeStoreError({
      message: Option.match(errnoOf(failure), {
        onNone: () => failure.message,
        onSome: (code) => `${failure.message} (${code})`,
      }),
    }),
  /* Whether `name` is a temp blob this store writes. */
  isTempName = (name: string): boolean =>
    name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX),
  /*
   * The stored blob, or none when nothing is stored, matching the Keychain
   * store, so an absent file reads as a decision rather than as an
   * unreachable store.
   */
  readBlob = (
    credPath: string,
  ): Effect.Effect<
    Option.Option<string>,
    ClaudeCodeStoreError,
    FileSystem.FileSystem
  > =>
    Effect.gen(function* read() {
      const fs = yield* FileSystem.FileSystem

      return Option.some(yield* fs.readFileString(credPath))
    }).pipe(
      Effect.catchTag("PlatformError", (failure: FileFailure) => {
        const missing = Option.exists(errnoOf(failure), (code) =>
          MISSING_CODES.has(code),
        )

        if (missing) {
          return Effect.succeed(Option.none<string>())
        }

        return Effect.fail(failedFile(failure))
      }),
    ),
  /* Remove `path` when it is a temp blob older than the sweep age. */
  sweepOne = Effect.fn("ClaudeCodeFileStore.sweepOne")(
    function* sweepOne(path: string, now: number) {
      const fs = yield* FileSystem.FileSystem,
        info = yield* fs.stat(path)

      // Without a modification time the file counts as just written.
      if (
        Option.isSome(info.mtime) &&
        now - info.mtime.value.getTime() > TEMP_SWEEP_AGE_MS
      ) {
        yield* fs.remove(path)
      }
    },
    (effect) => Effect.ignore(effect),
  ),
  /*
   * Drop temp blobs a killed process left behind. They hold a full token
   * pair, so they are not something to leave in the config directory
   * indefinitely. Sweeping is opportunistic; the write is what matters.
   */
  sweepStaleTemps = Effect.fn("ClaudeCodeFileStore.sweepStaleTemps")(
    function* sweepStaleTemps(dir: string) {
      const fs = yield* FileSystem.FileSystem,
        names = yield* fs.readDirectory(dir),
        now = yield* Clock.currentTimeMillis,
        path = yield* Path.Path,
        stale = names.filter((name) => isTempName(name))

      yield* Effect.forEach(
        stale,
        (name) => sweepOne(path.join(dir, name), now),
        { concurrency: "unbounded", discard: true },
      )
    },
    (effect) => Effect.ignore(effect),
  ),
  /*
   * Fsync the directory so the rename itself survives a crash. Not
   * supported on every platform; the rename still lands.
   */
  syncDirectory = (
    dir: string,
  ): Effect.Effect<void, never, FileSystem.FileSystem> =>
    Effect.gen(function* sync() {
      const fs = yield* FileSystem.FileSystem,
        handle = yield* fs.open(dir, { flag: "r" })

      yield* handle.sync
    }).pipe(Effect.scoped, Effect.ignore),
  /*
   * Write `blob` to the new file `tempPath`, private and flushed. A rename
   * is atomic for concurrent readers but says nothing about durability.
   * Without the flush, a crash can leave the new directory entry pointing
   * at unwritten data, and the user's credentials file comes back empty.
   */
  tempFile = Effect.fn("ClaudeCodeFileStore.writeTemp")(function* tempFile(
    tempPath: string,
    blob: string,
  ) {
    const environment = yield* Environment,
      fs = yield* FileSystem.FileSystem,
      handle = yield* fs.open(tempPath, { flag: "wx", mode: PRIVATE_FILE }),
      posix = environment.process.platform !== "win32"

    yield* handle.writeAll(codec.encode(blob))
    yield* fs
      .chmod(tempPath, PRIVATE_FILE)
      .pipe(Effect.when(Effect.succeed(posix)))
    yield* handle.sync
  }, Effect.scoped),
  /*
   * Replace the credentials file atomically: a private temp file, flushed,
   * renamed over it, and the directory flushed.
   */
  updateFile = Effect.fn("ClaudeCodeFileStore.publish")(
    function* updateFile(dir: string, blob: string) {
      const environment = yield* Environment,
        fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        pid = String(environment.process.pid),
        platformCrypto = yield* Crypto.Crypto,
        randomId = yield* platformCrypto.randomUUIDv4,
        target = path.join(dir, CREDENTIALS_FILE),
        tempPath = path.join(
          dir,
          `${TEMP_PREFIX}${pid}.${randomId}${TEMP_SUFFIX}`,
        ),
        // Already renamed into place, or never created.
        untemp = Effect.ignore(fs.remove(tempPath))

      yield* tempFile(tempPath, blob).pipe(
        Effect.andThen(fs.rename(tempPath, target)),
        Effect.andThen(syncDirectory(dir)),
        Effect.ensuring(untemp),
      )
      // After the rename, not before: the window between the token exchange
      // And the credential landing is the dangerous one, and nothing here
      // Needs to happen inside it.
      yield* sweepStaleTemps(dir)
    },
    Effect.mapError((failure: FileFailure) => failedFile(failure)),
  ),
  /* The credentials file in `configDir`, or in the default config directory. */
  withinDir = Effect.fn("ClaudeCodeFileStore.make")(function* withinDir(
    configDir: Option.Option<string>,
  ) {
    const dir = yield* sources.resolveConfigDir(configDir),
      path = yield* Path.Path

    return {
      /** Log context for every event this store emits. */
      fields: [
        ["source", sources.FILE_SOURCE],
        ["configDir", dir],
      ] as const,
      /** Nothing about a file write is slow enough to do ahead of it. */
      prepareWrite: Effect.succeed((blob: string) => updateFile(dir, blob)),
      read: readBlob(path.join(dir, CREDENTIALS_FILE)),
    }
  })

/** The credentials file in a Claude config directory. */
export default Object.freeze({ fileStore: withinDir })
