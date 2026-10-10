import { Effect, Path, Schema } from "effect"
import type { PlatformError, Stdio } from "effect"
import type { ChildProcessSpawner } from "effect/unstable/process"
import HeadlessSmokeError from "./headless-smoke-error.ts"
import commands from "./headless-command.ts"

const NO_CHANGES = {},
  PLUGIN_ENTRY = [
    "node_modules",
    "@martinthommesen",
    "oc-auth",
    "dist",
    "index.js",
  ],
  /**
   * What `pnpm pack --json` reports. pnpm, unlike npm, replaces the
   * workspace's `catalog:` versions with real ones in the packed manifest.
   */
  PackResult = Schema.fromJsonString(
    Schema.Struct({ filename: Schema.String }),
  ),
  /* The package directory, where `pnpm pack` runs. */
  checkout = Effect.gen(function* checkout() {
    const path = yield* Path.Path

    return yield* path.fromFileUrl(new URL("..", import.meta.url))
  }),
  /* Run `command` from the repository with the inherited environment. */
  inCheckout = (
    command: string,
    args: readonly string[],
  ): Effect.Effect<
    string,
    | HeadlessSmokeError
    | PlatformError.BadArgument
    | PlatformError.PlatformError,
    ChildProcessSpawner.ChildProcessSpawner | Path.Path | Stdio.Stdio
  > =>
    checkout.pipe(
      Effect.flatMap((cwd) =>
        commands.run({ args, command, cwd, env: NO_CHANGES }),
      ),
    ),
  /*
   * Install the requested host CLI into `cli` and check that it reports
   * that version. Returns the `opencode` executable.
   */
  installHost = Effect.fn("Headless.installHost")(function* installHost(
    cli: string,
    hostVersion: string,
  ) {
    const executable = (yield* Path.Path).join(
        cli,
        "node_modules",
        ".bin",
        "opencode",
      ),
      required = `opencode v${hostVersion}`,
      version = yield* inCheckout("npm", [
        "install",
        "--prefix",
        cli,
        `@opencode/cli@${hostVersion}`,
      ]).pipe(
        Effect.andThen(inCheckout(executable, ["--version"])),
        Effect.map((output) => output.trim()),
      )

    if (version !== required) {
      return yield* HeadlessSmokeError.make({
        message: `Expected ${required}, found ${version}`,
      })
    }

    return executable
  }),
  /*
   * Pack this package into `packed`, install the tarball into `install`,
   * and return the URL of the installed plugin entry.
   */
  installPlugin = Effect.fn("Headless.installPlugin")(function* installPlugin(
    packed: string,
    install: string,
  ) {
    const fsPath = yield* Path.Path,
      pluginEntry = fsPath.join(install, ...PLUGIN_ENTRY),
      report = yield* inCheckout("pnpm", [
        "pack",
        "--json",
        "--pack-destination",
        packed,
      ]).pipe(
        Effect.flatMap((output) => Schema.decodeEffect(PackResult)(output)),
      ),
      url = yield* inCheckout("npm", [
        "install",
        "--ignore-scripts",
        "--prefix",
        install,
        fsPath.resolve(packed, report.filename),
      ]).pipe(Effect.andThen(fsPath.toFileUrl(pluginEntry)))

    return url.href
  })

/** Installing the host CLI and the packed plugin into the sandbox. */
export default Object.freeze({
  host: installHost,
  plugin: installPlugin,
})
