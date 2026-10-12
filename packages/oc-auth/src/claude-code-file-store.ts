import { Clock, Crypto, Effect, FileSystem, Option, Path } from "effect"
import ClaudeCodeStoreError from "./claude-code-store-error.ts"
import Environment from "./environment.ts"
import failures from "./claude-code-file-failures.ts"
import sources from "./claude-code-sources.ts"

type Cleanup = Parameters<typeof failures.quietly>[typeof SECOND]

/** The parts of a platform failure this store reports or decides on. */
interface FileFailure {
  readonly cause?: unknown
  readonly message: string
}

const CREDENTIALS_FILE = ".credentials.json",
  /** The code of a file that is already gone. */
  GONE_CODES = ["ENOENT"],
  /** Codes that mean nothing is stored, rather than an unreadable store. */
  MISSING_CODES: ReadonlySet<string> = new Set(["ENOENT", "ENOTDIR"]),
  PRIVATE_FILE = 0o600,
  SECOND = 1,
  TEMP_PREFIX = ".credentials.json.",
  TEMP_SUFFIX = ".tmp",
  TEMP_SWEEP_AGE_MS = 3_600_000,
  /*
   * The codes of a directory sync the platform or file system doesn't
   * support: EINVAL, ENOTSUP, and EOPNOTSUPP from a file system that can't
   * sync a directory, and EISDIR and EPERM from Windows, which can neither
   * open a directory as a file nor sync one.
   */
  UNSUPPORTED_SYNC_CODES = [
    "EINVAL",
    "EISDIR",
    "ENOTSUP",
    "EOPNOTSUPP",
    "EPERM",
  ],
  codec = new TextEncoder(),
  /* A failed write, as the store error the write-back logs. */
  failedFile = (failure: FileFailure): ClaudeCodeStoreError =>
    ClaudeCodeStoreError.make({ message: failures.explained(failure) }),
  /* Whether `name` is a temp blob this store writes. */
  isTempName = (name: string): boolean =>
    name.startsWith(TEMP_PREFIX) && name.endsWith(TEMP_SUFFIX),
  /* A file that exists but cannot be read, as the store error the user sees. */
  notReadable = (failure: FileFailure): ClaudeCodeStoreError =>
    ClaudeCodeStoreError.make({
      message: `The Claude Code credentials file could not be read: ${failures.explained(failure)}. Check that it is a file you can read, then try again.`,
    }),
  /*
   * The stored blob, or none when there is no file. Like a missing Keychain
   * item, a missing file means nothing is stored, so the write-back refuses
   * it instead of retrying as if the store were unreachable.
   */
  readBlob = Effect.fn("ClaudeCodeFileStore.readBlob")(
    function* readBlob(credPath: string) {
      const fs = yield* FileSystem.FileSystem

      return Option.some(yield* fs.readFileString(credPath))
    },
    Effect.catchTag("PlatformError", (failure: FileFailure) => {
      const missing = Option.exists(failures.errnoOf(failure), (code) =>
        MISSING_CODES.has(code),
      )

      if (missing) {
        return Effect.succeed(Option.none<string>())
      }

      return Effect.fail(notReadable(failure))
    }),
  ),
  /* The sweep's `step` on `path` in `dir`, as a cleanup to report. */
  sweepAt = (dir: string, path: string, step: string): Cleanup => ({
    dir,
    event: "credential_sweep_failed",
    expected: GONE_CODES,
    path,
    step,
  }),
  /*
   * Remove `path` in `dir` when it is a temp blob older than the sweep age.
   * A file another process removed first is no failure.
   */
  sweepOne = Effect.fn("ClaudeCodeFileStore.sweepOne")(function* sweepOne(
    dir: string,
    path: string,
    now: number,
  ) {
    const fs = yield* FileSystem.FileSystem,
      info = yield* failures.quietly(fs.stat(path), sweepAt(dir, path, "stat")),
      mtime = info.pipe(
        Option.flatMap(
          (found: { readonly mtime: Option.Option<Date> }) => found.mtime,
        ),
      )

    // Without a modification time the file counts as just written.
    if (
      Option.isSome(mtime) &&
      now - mtime.value.getTime() > TEMP_SWEEP_AGE_MS
    ) {
      yield* failures.quietly(fs.remove(path), sweepAt(dir, path, "remove"))
    }
  }),
  /*
   * Remove the temp blobs a killed process left behind, since each holds a
   * full token pair. The write has landed by then, so a failure is only
   * reported, and one blob that can't be removed doesn't keep the others.
   */
  sweepStaleTemps = Effect.fn("ClaudeCodeFileStore.sweepStaleTemps")(
    function* sweepStaleTemps(dir: string) {
      const fs = yield* FileSystem.FileSystem,
        names = yield* failures.quietly(
          fs.readDirectory(dir),
          sweepAt(dir, dir, "list"),
        ),
        now = yield* Clock.currentTimeMillis,
        path = yield* Path.Path,
        stale = Option.getOrElse(names, () => []).filter((name) =>
          isTempName(name),
        )

      yield* Effect.forEach(
        stale,
        (name) => sweepOne(dir, path.join(dir, name), now),
        { concurrency: "unbounded", discard: true },
      )
    },
  ),
  /*
   * Fsync the directory so the rename itself survives a crash. The rename
   * lands either way, so a failure is only reported, and a platform or file
   * system that can't sync a directory is no failure.
   */
  syncDirectory = Effect.fn("ClaudeCodeFileStore.syncDirectory")(
    function* syncDirectory(dir: string) {
      const fs = yield* FileSystem.FileSystem

      yield* failures.quietly(
        fs
          .open(dir, { flag: "r" })
          .pipe(Effect.flatMap((handle: FileSystem.File) => handle.sync)),
        {
          dir,
          event: "credential_sync_failed",
          expected: UNSUPPORTED_SYNC_CODES,
          path: dir,
          step: "sync",
        },
      )
    },
    Effect.scoped,
  ),
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
        // Already renamed into place, or never created, unless reported.
        untemp = failures.quietly(fs.remove(tempPath), {
          dir,
          event: "credential_temp_kept",
          expected: GONE_CODES,
          path: tempPath,
          step: "remove",
        })

      yield* tempFile(tempPath, blob).pipe(
        Effect.andThen(fs.rename(tempPath, target)),
        Effect.andThen(syncDirectory(dir)),
        Effect.ensuring(untemp),
      )
      /*
       * The sweep runs after the rename, so it adds nothing to the window
       * between the token exchange and the new tokens landing.
       */
      yield* sweepStaleTemps(dir)
    },
    Effect.mapError((failure: FileFailure) => failedFile(failure)),
  ),
  /* The credentials file in `configDir`, or in the default config directory. */
  withinDir = Effect.fn("ClaudeCodeFileStore.fileStore")(function* withinDir(
    configDir: Option.Option<string>,
  ) {
    const dir = yield* sources.resolveConfigDir(configDir),
      path = yield* Path.Path

    return {
      fields: [
        ["source", sources.FILE_SOURCE],
        ["configDir", dir],
      ] as const,
      /** Nothing about a file write is slow enough to do ahead of it. */
      prepareWrite: Effect.succeed((blob: string) => updateFile(dir, blob)),
      read: readBlob(path.join(dir, CREDENTIALS_FILE)),
    }
  })

/** The credentials file in a Claude Code config directory. */
export default Object.freeze({ fileStore: withinDir })
