import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Effect, FileSystem, Path, pipe } from "effect"

const FILES = {
    "libs/kit/package.json": '{ "name": "@oc-lib/kit" }\n',
    "libs/kit/src/kit.ts": "export default 1\n",
    "packages/oc-demo/README.md": "# oc-demo\n",
    "packages/oc-demo/src/index.ts":
      'import kit from "@oc-lib/kit/kit.ts"\n\nexport default kit\n',
    "tools/check.ts": "export default {}\n",
  },
  /* Run `git` with `args` in `root`. Succeeds with what it printed. */
  git = Effect.fn("test.git")(function* git(
    root: string,
    args: readonly string[],
  ) {
    const processes = yield* ChildProcessSpawner.ChildProcessSpawner

    return yield* processes.string(
      ChildProcess.make("git", args, {
        cwd: root,
      }),
    )
  }),
  /* Write `text` to `file`, a path from `root`, and its folder. */
  put = Effect.fn("test.put")(function* put(
    root: string,
    file: string,
    text: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      target = path.join(root, file)

    yield* fs.makeDirectory(path.dirname(target), { recursive: true })
    yield* fs.writeFileString(target, text)
  }),
  /*
   * A Git repository in a scoped temporary folder, with a plugin that
   * bundles one library and every file staged. Succeeds with its path.
   */
  stagedRepository = Effect.fn("test.stagedRepository")(
    function* stagedRepository() {
      const fs = yield* FileSystem.FileSystem,
        root = yield* fs.makeTempDirectoryScoped()

      yield* pipe(
        Object.entries(FILES),
        Effect.forEach(([file, text]: readonly [string, string]) =>
          put(root, file, text),
        ),
      )
      yield* git(root, ["init", "--quiet"])
      yield* git(root, ["add", "--all"])

      return root
    },
  )

/** A Git repository to stage files in, and the commands to drive it. */
/** @internal */
export default Object.freeze({ FILES, git, put, stagedRepository })
