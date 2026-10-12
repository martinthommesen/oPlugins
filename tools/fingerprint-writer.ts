import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Effect, FileSystem, Option, Path, pipe } from "effect"
import FingerprintError from "./fingerprint-error.ts"
import libraryFingerprints from "./library-fingerprints.ts"
import readSnapshot from "./read-snapshot.ts"

type Fingerprint = Effect.Success<
  ReturnType<typeof libraryFingerprints.expected>
>[number]

const SUCCESS = 0,
  /* Run `git` with `args` in `root`, failing unless it succeeds. */
  git = Effect.fn("Fingerprints.git")(function* git(
    root: string,
    args: readonly string[],
  ) {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner

    yield* processes
      .exitCode(
        ChildProcess.make("git", args, {
          cwd: root,
          stderr: "inherit",
          stdin: "ignore",
          stdout: "inherit",
        }),
      )
      .pipe(
        Effect.filterOrFail(
          (code) => code === SUCCESS,
          (code) =>
            FingerprintError.make({
              message: `git ${args.join(" ")} exited ${String(code)}. Read its output above for the cause.`,
            }),
        ),
      )
  }),
  /*
   * Write `fingerprint` into the repository at `root`, unless it already
   * reads so. Succeeds with its path when it wrote it.
   */
  put = Effect.fn("Fingerprints.put")(function* put(
    root: string,
    fingerprint: Fingerprint,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      target = path.join(root, fingerprint.file),
      text = yield* fs.readFileString(target).pipe(
        Effect.asSome,
        Effect.catchReason(
          "PlatformError",
          "NotFound",
          () => Effect.succeedNone,
        ),
      )

    if (Option.contains(text, fingerprint.text)) {
      return Option.none<string>()
    }

    yield* fs.writeFileString(target, fingerprint.text)

    return Option.some(fingerprint.file)
  }),
  /*
   * Write into the repository at `root` each fingerprint that the files in
   * the folder `source` make. Succeeds with every fingerprint's path, and
   * the paths of those it changed.
   */
  refresh = Effect.fn("Fingerprints.refresh")(function* refresh(
    source: string,
    root: string,
  ) {
    const layout = yield* readSnapshot.read(source),
      wanted = yield* libraryFingerprints.expected(layout),
      written = yield* pipe(
        wanted,
        Effect.forEach((fingerprint) => put(root, fingerprint)),
      )

    return {
      changed: written.flatMap((file) => Option.toArray(file)),
      files: wanted.map((fingerprint) => fingerprint.file),
    }
  }),
  /*
   * Write every plugin's fingerprint from the files staged in the Git
   * repository at `root`, then stage the fingerprints and nothing else.
   * The staged files are exported to a temporary folder first, so an edit
   * that isn't staged never reaches a staged fingerprint. Succeeds with the
   * paths it changed.
   */
  stage = Effect.fn("Fingerprints.stage")(function* stage(root: string) {
    const disk = yield* FileSystem.FileSystem,
      scratch = yield* disk.makeTempDirectoryScoped(),
      written = yield* git(root, [
        "checkout-index",
        "--all",
        `--prefix=${scratch}/`,
      ]).pipe(Effect.andThen(refresh(scratch, root)))

    yield* git(root, ["add", "--", ...written.files])

    return written.changed
  }, Effect.scoped),
  /*
   * Write every plugin's fingerprint from the files in the repository at
   * `root`. Succeeds with the paths it changed.
   */
  write = Effect.fn("Fingerprints.write")(function* write(root: string) {
    const written = yield* refresh(root, root)

    return written.changed
  })

/** Writing the plugins' fingerprints, from the working tree or the index. */
/** @internal */
export default Object.freeze({ stage, write })
