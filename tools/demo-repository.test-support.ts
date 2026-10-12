import {
  Array as Arr,
  Effect,
  FileSystem,
  Option,
  Path,
  PlatformError,
  Ref,
  Sink,
  Stdio,
  Stream,
} from "effect"

/** A file system operation a test can make fail. */
type Operation = "readDirectory" | "readFileString" | "stat"

/** One operation on one path, failing as the test says. */
interface Fault {
  readonly failure: Effect.Effect<never, PlatformError.PlatformError>
  readonly operation: Operation
  /** The path from the repository root. */
  readonly path: string
}

const FILES = {
    "libs/kit/package.json": "{}\n",
    "libs/kit/src/kit.ts": "export default {}\n",
    "packages/oc-demo/package.json": "{}\n",
    "packages/oc-demo/src/index.ts": "export default {}\n",
    "pnpm-workspace.yaml": "packages: []\n",
    "tools/check.ts": "export default {}\n",
  },
  /*
   * A repository in a scoped temporary folder: a plugin, a library, a
   * tool, and one root file. The other root files and the plugin's
   * installed host manifest are absent. Succeeds with its path.
   */
  demoRepository = Effect.fn("test.demoRepository")(function* demoRepository() {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      root = yield* fs.makeTempDirectoryScoped()

    yield* Effect.forEach(
      Object.entries(FILES),
      ([file, text]: readonly [string, string]) => {
        const target = path.join(root, file)

        return fs
          .makeDirectory(path.dirname(target), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(target, text)))
      },
    )

    return root
  }),
  /* `operation` on `path`, from the root, fails as when permission is denied. */
  denied = (operation: Operation, path: string): Fault => ({
    failure: Effect.fail(
      PlatformError.badArgument({
        description: "permission denied",
        method: operation,
        module: "FileSystem",
      }),
    ),
    operation,
    path,
  }),
  /* The failure `faults` give `operation` on the absolute `path`, if any. */
  faultAt = (
    faults: readonly Fault[],
    operation: Operation,
    path: string,
  ): Option.Option<Effect.Effect<never, PlatformError.PlatformError>> =>
    Arr.findFirst(
      faults,
      (fault) =>
        fault.operation === operation && path.endsWith(`/${fault.path}`),
    ).pipe(Option.map((fault) => fault.failure)),
  /*
   * The file system the test runs on, except that each operation `faults`
   * names fails as it says.
   */
  faulty = Effect.fn("test.faulty")(function* faulty(faults: readonly Fault[]) {
    const fs = yield* FileSystem.FileSystem

    return FileSystem.makeNoop({
      readDirectory: (path, options) =>
        Option.getOrElse(faultAt(faults, "readDirectory", path), () =>
          fs.readDirectory(path, options),
        ),
      readFileString: (path, encoding) =>
        Option.getOrElse(faultAt(faults, "readFileString", path), () =>
          fs.readFileString(path, encoding),
        ),
      stat: (path) =>
        Option.getOrElse(faultAt(faults, "stat", path), () => fs.stat(path)),
    })
  }),
  /* A `Stdio` that appends what is written to its stderr to `printed`. */
  printingTo = (printed: Ref.Ref<string>): Stdio.Stdio =>
    Stdio.make({
      args: Effect.succeed([]),
      stderr: () =>
        Sink.forEachArray((items) =>
          Ref.update(printed, (sofar) => `${sofar}${items.join("")}`),
        ),
      stdin: Stream.empty,
      stdout: () => Sink.drain,
    })

/** A demo repository, and file systems and stdio that tests control. */
export default Object.freeze({
  demoRepository,
  denied,
  faulty,
  printingTo,
})
