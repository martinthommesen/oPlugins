import { Console, Effect, Exit, FileSystem, Path, pipe } from "effect"
import type { Stdio } from "effect"
import commands from "./headless-command.ts"

/** Where everything lives inside one sandbox. */
interface Layout {
  readonly bin: string
  readonly cache: string
  readonly cli: string
  readonly config: string
  readonly data: string
  readonly install: string
  readonly log: string
  readonly models: string
  readonly packed: string
  readonly plugins: string
  readonly root: string
  readonly security: string
  readonly smoke: string
  readonly state: string
  readonly work: string
}

const EXECUTABLE = 0o755,
  SANDBOX_PREFIX = "oc-auth-",
  /* The paths of the sandbox at `root`. */
  atRoot = Effect.fn("Headless.layout")(function* atRoot(
    root: string,
  ): Effect.fn.Return<Layout, never, Path.Path> {
    const path = yield* Path.Path,
      work = path.join(root, "work")

    return {
      bin: path.join(root, "bin"),
      cache: path.join(root, "cache"),
      cli: path.join(root, "cli"),
      config: path.join(root, "config"),
      data: path.join(root, "data"),
      install: path.join(root, "install"),
      log: path.join(root, "plugin.log"),
      models: path.join(root, "models.json"),
      packed: path.join(root, "package"),
      plugins: path.join(root, "config", "opencode", "plugins"),
      root,
      security: path.join(root, "bin", "security"),
      smoke: path.join(work, "smoke.txt"),
      state: path.join(root, "state"),
      work,
    }
  }),
  /*
   * The plugin's own account of a failure, printed because the sandbox is
   * about to be removed (it can hold a copied token). No log may have been
   * written.
   */
  dumpLog = (
    root: string,
  ): Effect.Effect<
    void,
    never,
    FileSystem.FileSystem | Path.Path | Stdio.Stdio
  > =>
    Effect.gen(function* readLog() {
      const fs = yield* FileSystem.FileSystem,
        layout = yield* atRoot(root),
        text = yield* fs.readFileString(layout.log)

      yield* commands.printError(`--- plugin.log ---\n${text}`)
    }).pipe(Effect.ignore),
  /* Remove the sandbox, unless `HEADLESS_KEEP` asks to keep it. */
  finish = Effect.fn("Headless.releaseSandbox")(function* finish(
    root: string,
    keep: boolean,
    exit: Exit.Exit<unknown, unknown>,
  ) {
    const failed = Exit.isFailure(exit),
      fs = yield* FileSystem.FileSystem

    yield* dumpLog(root).pipe(Effect.when(Effect.succeed(failed)))

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
        (made, exit) => finish(made, keep, exit),
      )

    return yield* atRoot(root)
  }),
  /* Create the sandbox's directories and its `security` stand-in. */
  prepare = Effect.fn("Headless.furnish")(function* prepare(
    layout: Layout,
    securityStub: string,
  ) {
    const directories = [
        layout.cli,
        layout.packed,
        layout.install,
        layout.plugins,
        layout.data,
        layout.cache,
        layout.work,
        layout.bin,
      ],
      fs = yield* FileSystem.FileSystem

    yield* pipe(
      directories,
      Effect.forEach((directory) =>
        fs.makeDirectory(directory, { recursive: true }),
      ),
    )
    yield* fs.writeFileString(layout.security, securityStub)
    yield* fs.chmod(layout.security, EXECUTABLE)
  })

/** The smoke test's scoped sandbox. */
export default Object.freeze({ acquire: open, furnish: prepare })
