import { Console, Effect, FileSystem, Path, pipe } from "effect"

/** Where everything lives inside one sandbox. */
interface Layout {
  readonly cache: string
  readonly cli: string
  readonly config: string
  readonly data: string
  readonly install: string
  readonly marker: string
  readonly packed: string
  readonly plugins: string
  readonly root: string
  readonly state: string
  readonly work: string
}

const SANDBOX_PREFIX = "oc-browser-",
  /* The paths of the sandbox at `root`. */
  atRoot = Effect.fn("Headless.layout")(function* atRoot(
    root: string,
  ): Effect.fn.Return<Layout, never, Path.Path> {
    const path = yield* Path.Path

    return {
      cache: path.join(root, "cache"),
      cli: path.join(root, "cli"),
      config: path.join(root, "config"),
      data: path.join(root, "data"),
      install: path.join(root, "install"),
      marker: path.join(root, "started.txt"),
      packed: path.join(root, "package"),
      plugins: path.join(root, "config", "opencode", "plugins"),
      root,
      state: path.join(root, "state"),
      work: path.join(root, "work"),
    }
  }),
  /* Remove the sandbox, unless `HEADLESS_KEEP` asks to keep it. */
  finish = Effect.fn("Headless.releaseSandbox")(function* finish(
    root: string,
    keep: boolean,
  ) {
    const fs = yield* FileSystem.FileSystem

    if (keep) {
      yield* Console.log(`HEADLESS_KEEP set; sandbox preserved at ${root}`)

      return
    }

    yield* fs.remove(root, { force: true, recursive: true })
  }, Effect.orDie),
  /* A fresh temporary sandbox, removed when the enclosing scope closes. */
  open = Effect.fn("Headless.acquireSandbox")(function* open(keep: boolean) {
    const fs = yield* FileSystem.FileSystem,
      root = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix: SANDBOX_PREFIX }),
        (made) => finish(made, keep),
      )

    return yield* atRoot(root)
  }),
  /* Create the sandbox's directories. */
  prepare = Effect.fn("Headless.furnish")(function* prepare(layout: Layout) {
    const directories = [
        layout.cli,
        layout.packed,
        layout.install,
        layout.plugins,
        layout.data,
        layout.cache,
        layout.state,
        layout.work,
      ],
      fs = yield* FileSystem.FileSystem

    yield* pipe(
      directories,
      Effect.forEach((directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      ),
    )
  })

/** The smoke test's scoped sandbox. */
export default Object.freeze({ acquire: open, furnish: prepare })
