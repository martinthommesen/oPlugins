import { Console, Effect, Exit, FileSystem, Path, pipe } from "effect"
import type { Stdio } from "effect"
import commands from "./command.ts"

/** Where everything lives inside one sandbox. */
interface Layout {
  readonly cache: string
  readonly cli: string
  readonly config: string
  readonly data: string
  /** The log the host writes, which holds the plugin's records too. */
  readonly hostLog: string
  readonly install: string
  /** The file the plugin wrapper appends the plugin's ID to once it starts. */
  readonly marker: string
  /** Where the host's `opencode.json` goes. */
  readonly opencodeConfig: string
  readonly packed: string
  /** The host's directory of local plugin files. */
  readonly plugins: string
  readonly root: string
  readonly state: string
  readonly work: string
}

/** The variables the host runs with, over the inherited environment. */
type HostVariable =
  | "XDG_CACHE_HOME"
  | "XDG_CONFIG_HOME"
  | "XDG_DATA_HOME"
  | "XDG_STATE_HOME"

/* The paths of the sandbox at `root`. */
const atRoot = Effect.fn("HostTest.layout")(function* atRoot(
    root: string,
  ): Effect.fn.Return<Layout, never, Path.Path> {
    const path = yield* Path.Path

    return {
      cache: path.join(root, "cache"),
      cli: path.join(root, "cli"),
      config: path.join(root, "config"),
      data: path.join(root, "data"),
      hostLog: path.join(root, "data", "opencode", "log", "opencode.log"),
      install: path.join(root, "install"),
      marker: path.join(root, "started.txt"),
      opencodeConfig: path.join(root, "config", "opencode"),
      packed: path.join(root, "package"),
      plugins: path.join(root, "config", "opencode", "plugins"),
      root,
      state: path.join(root, "state"),
      work: path.join(root, "work"),
    }
  }),
  /*
   * The host's account of a failure, which includes the plugin's warnings,
   * printed because the sandbox is about to be removed. No log may have been
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
        text = yield* fs.readFileString(layout.hostLog)

      yield* commands.printError(`--- opencode.log ---\n${text}`)
    }).pipe(Effect.ignore),
  /*
   * Print the host log if the test failed, then remove the sandbox, unless
   * `HEADLESS_KEEP` asks to keep it.
   */
  finish = Effect.fn("HostTest.releaseSandbox")(function* finish(
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
  /* The host's directories all live in the sandbox. */
  hostEnvironment = (
    layout: Layout,
  ): Readonly<Record<HostVariable, string>> => ({
    XDG_CACHE_HOME: layout.cache,
    XDG_CONFIG_HOME: layout.config,
    XDG_DATA_HOME: layout.data,
    XDG_STATE_HOME: layout.state,
  }),
  /*
   * A fresh temporary sandbox named after `prefix`, removed when the
   * enclosing scope closes.
   */
  open = Effect.fn("HostTest.acquireSandbox")(function* open(
    prefix: string,
    keep: boolean,
  ) {
    const fs = yield* FileSystem.FileSystem,
      root = yield* Effect.acquireRelease(
        fs.makeTempDirectory({ prefix }),
        (made, exit) => finish(made, keep, exit),
      )

    return yield* atRoot(root)
  }),
  /* Create the sandbox's directories. */
  prepare = Effect.fn("HostTest.furnish")(function* prepare(layout: Layout) {
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

/** The host test's scoped sandbox. */
export default Object.freeze({
  acquire: open,
  environment: hostEnvironment,
  furnish: prepare,
  layout: atRoot,
})
