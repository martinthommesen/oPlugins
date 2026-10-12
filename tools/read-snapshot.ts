import { Array as Arr, Effect, FileSystem, Option, Path, pipe } from "effect"
import LayoutReadError from "./layout-read-error.ts"
import type Snapshot from "./snapshot.ts"

const CONCURRENCY = { concurrency: 16 },
  /**
   * Each plugin's installed host manifest. It's legitimately absent before
   * `pnpm install`, and the catalog rules skip a plugin without one.
   */
  HOST_MANIFEST = "node_modules/@opencode/plugin/package.json",
  /**
   * The files at the repository root that the checks read. When one is
   * absent, the rules that need it report it missing.
   */
  ROOT_FILES = [
    ".github/workflows/release.yml",
    ".release-please-manifest.json",
    "pnpm-workspace.yaml",
    "release-please-config.json",
  ],
  SKIPPED = ["dist", "node_modules"],
  /** `tools/oxlint/` holds vendored lint rules, which follow their upstream. */
  TOOLS_SKIPPED = ["dist", "node_modules", "oxlint"],
  /* The failure to read `entry`, a path from the root, naming it and why. */
  cannotRead = (
    entry: string,
    failure: { readonly message: string },
  ): LayoutReadError =>
    LayoutReadError.make({
      message: `${entry}: The layout check can't read it: ${failure.message}. Make it readable, then run pnpm run check:layout again.`,
    }),
  /* The names in the folder `entry`, a path from `root`. */
  childrenOf = Effect.fn("Layout.childrenOf")(function* childrenOf(
    root: string,
    entry: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path

    return yield* fs
      .readDirectory(path.join(root, entry))
      .pipe(Effect.mapError((failure) => cannotRead(entry, failure)))
  }),
  /* The text of the file `file`, a path from `root`. */
  contentOf = Effect.fn("Layout.contentOf")(function* contentOf(
    root: string,
    file: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path

    return yield* fs.readFileString(path.join(root, file))
  }),
  /* Whether `entry`, a path from `root`, is a directory. */
  directoryAt = Effect.fn("Layout.directoryAt")(function* directoryAt(
    root: string,
    entry: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      stats = yield* fs
        .stat(path.join(root, entry))
        .pipe(Effect.mapError((failure) => cannotRead(entry, failure)))

    return stats.type === "Directory"
  }),
  /*
   * The files at `entry`, a path from `root`: the entry itself when it's a
   * file, or every file under it when it's a directory.
   */
  filesAt = (
    root: string,
    entry: string,
  ): Effect.Effect<
    readonly string[],
    LayoutReadError,
    FileSystem.FileSystem | Path.Path
  > =>
    directoryAt(root, entry).pipe(
      Effect.flatMap((directory) => {
        if (!directory) {
          return Effect.succeed([entry])
        }

        return childrenOf(root, entry).pipe(
          Effect.flatMap((children: readonly string[]) =>
            Effect.forEach(
              children,
              (name) => filesAt(root, `${entry}/${name}`),
              CONCURRENCY,
            ),
          ),
          Effect.map((nested: readonly (readonly string[])[]) => nested.flat()),
        )
      }),
    ),
  /* Every file in `folder`, except under its top-level entries `skipped`. */
  filesIn = Effect.fn("Layout.filesIn")(function* filesIn(
    root: string,
    folder: string,
    skipped: readonly string[],
  ) {
    const children = yield* childrenOf(root, folder),
      kept = children.filter((name) => !skipped.includes(name)),
      within = yield* Effect.forEach(
        kept,
        (name) => filesAt(root, `${folder}/${name}`),
        CONCURRENCY,
      )

    return within.flat()
  }),
  /* The folders in `folder`, sorted by name. */
  foldersIn = Effect.fn("Layout.foldersIn")(function* foldersIn(
    root: string,
    folder: string,
  ) {
    const topLevel = yield* childrenOf(root, folder)

    return (yield* pipe(
      topLevel,
      Effect.filter((name) => directoryAt(root, `${folder}/${name}`)),
    )).toSorted()
  }),
  /*
   * Each of `files`, paths from `root`, with its text, leaving out the ones
   * that don't exist. A file that exists but can't be read fails.
   */
  readOptional = Effect.fn("Layout.readOptional")(function* readOptional(
    root: string,
    files: readonly string[],
  ) {
    const texts = yield* Effect.forEach(
      files,
      (file) =>
        contentOf(root, file).pipe(
          Effect.map((text) => Option.some([file, text] as const)),
          Effect.catchReason(
            "PlatformError",
            "NotFound",
            () => Effect.succeedNone,
          ),
          Effect.mapError((failure) => cannotRead(file, failure)),
        ),
      CONCURRENCY,
    )

    return Arr.getSomes(texts)
  }),
  /* Each of `files`, paths from `root`, with its text. */
  readRequired = Effect.fn("Layout.readRequired")(function* readRequired(
    root: string,
    files: readonly string[],
  ) {
    return yield* Effect.forEach(
      files,
      (file) =>
        contentOf(root, file).pipe(
          Effect.map((text) => [file, text] as const),
          Effect.mapError((failure) => cannotRead(file, failure)),
        ),
      CONCURRENCY,
    )
  }),
  /*
   * The repository at `root`, as the layout check reads it. It fails,
   * naming the path, when a file or folder it inspects can't be read.
   */
  readSnapshot = Effect.fn("Layout.read")(function* readSnapshot(
    root: string,
  ): Effect.fn.Return<
    typeof Snapshot.Type,
    LayoutReadError,
    FileSystem.FileSystem | Path.Path
  > {
    const libraries = yield* foldersIn(root, "libs"),
      plugins = yield* foldersIn(root, "packages"),
      roots = [
        ...plugins.map((folder) => `packages/${folder}`),
        ...libraries.map((folder) => `libs/${folder}`),
      ],
      sources = yield* pipe(
        roots,
        Effect.forEach((folder) => filesIn(root, folder, SKIPPED)),
      ),
      toolFiles = yield* filesIn(root, "tools", TOOLS_SKIPPED),
      withText = yield* readRequired(root, [...sources.flat(), ...toolFiles]),
      withTextIfPresent = yield* readOptional(root, [
        ...ROOT_FILES,
        ...plugins.map((folder) => `packages/${folder}/${HOST_MANIFEST}`),
      ])

    return {
      files: Object.fromEntries([...withText, ...withTextIfPresent]),
      libraries,
      plugins,
    }
  })

/** Reading the repository into the snapshot the layout check runs over. */
export default Object.freeze({ read: readSnapshot })
