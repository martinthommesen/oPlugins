import { Array as Arr, Effect, FileSystem, Path, pipe } from "effect"
import type Snapshot from "./snapshot.ts"

const CONCURRENCY = { concurrency: 16 },
  HOST_MANIFEST = "node_modules/@opencode/plugin/package.json",
  /** The files at the repository root that the checks read. */
  ROOT_FILES = [
    ".release-please-manifest.json",
    "pnpm-workspace.yaml",
    "release-please-config.json",
  ],
  SKIPPED = ["dist", "node_modules"],
  /** `tools/oxlint/` holds vendored lint rules, which follow their upstream. */
  TOOLS_SKIPPED = ["dist", "node_modules", "oxlint"],
  /* Whether `entry`, a path from `root`, is a directory. */
  directoryAt = Effect.fn("Layout.directoryAt")(function* directoryAt(
    root: string,
    entry: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path

    return (yield* fs.stat(path.join(root, entry))).type === "Directory"
  }),
  /*
   * The entry `entry`, a path from `root`, and everything under it when
   * it's a directory. Reading the texts keeps only the files.
   */
  entriesOf = Effect.fn("Layout.entriesOf")(function* entriesOf(
    root: string,
    entry: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      within = yield* fs
        .readDirectory(path.join(root, entry), { recursive: true })
        .pipe(Effect.orElseSucceed((): readonly string[] => []))

    return [
      entry,
      ...within.map(
        (relative) => `${entry}/${relative.split(path.sep).join("/")}`,
      ),
    ]
  }),
  /* Every entry in `folder`, except its top-level entries `skipped`. */
  entriesUnder = Effect.fn("Layout.entriesUnder")(function* entriesUnder(
    root: string,
    folder: string,
    skipped: readonly string[],
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      topLevel = yield* fs.readDirectory(path.join(root, folder)),
      walks = topLevel.flatMap((name) => {
        if (skipped.includes(name)) {
          return []
        }

        return [entriesOf(root, `${folder}/${name}`)]
      }),
      withinEach = yield* Effect.all(walks, CONCURRENCY)

    return withinEach.flat()
  }),
  /* The folders in `folder`, sorted by name. */
  foldersIn = Effect.fn("Layout.foldersIn")(function* foldersIn(
    root: string,
    folder: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      topLevel = yield* fs.readDirectory(path.join(root, folder))

    return (yield* pipe(
      topLevel,
      Effect.filter((name) => directoryAt(root, `${folder}/${name}`)),
    )).toSorted()
  }),
  /* Each of `files` that is a file, by its path from `root`, with its text. */
  readPresent = Effect.fn("Layout.readPresent")(function* readPresent(
    root: string,
    files: readonly string[],
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      reads = files.map((file) =>
        fs.readFileString(path.join(root, file)).pipe(
          Effect.map((text) => [file, text] as const),
          Effect.option,
        ),
      ),
      texts = yield* Effect.all(reads, CONCURRENCY)

    return Arr.getSomes(texts)
  }),
  /* The repository at `root`, as the layout check reads it. */
  readSnapshot = Effect.fn("Layout.read")(function* readSnapshot(
    root: string,
  ): Effect.fn.Return<
    typeof Snapshot.Type,
    Effect.Error<ReturnType<typeof entriesUnder>>,
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
        Effect.forEach((folder) => entriesUnder(root, folder, SKIPPED)),
      ),
      toolFiles = yield* entriesUnder(root, "tools", TOOLS_SKIPPED),
      withText = yield* readPresent(root, [
        ...sources.flat(),
        ...toolFiles,
        ...ROOT_FILES,
        ...plugins.map((folder) => `packages/${folder}/${HOST_MANIFEST}`),
      ])

    return { files: Object.fromEntries(withText), libraries, plugins }
  })

/** Reading the repository into the snapshot the layout check runs over. */
export default Object.freeze({ read: readSnapshot })
