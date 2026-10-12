import { Effect, Path, Schema } from "effect"
import HostTestError from "./host-test-error.ts"
import commands from "./command.ts"

/** Where to install which host CLI, and the package directory to run from. */
interface HostInstall {
  /** The plugin's package directory. */
  readonly checkout: string
  readonly cli: string
  readonly version: string
}

/** Which plugin to pack where, and where to install the tarball. */
interface PluginInstall {
  /** The plugin's package directory, where `pnpm pack` runs. */
  readonly checkout: string
  readonly install: string
  /** The plugin's npm name, such as `@martinthommesen/oc-browser`. */
  readonly npmName: string
  readonly packed: string
}

const NO_CHANGES = {},
  /** The part of `pnpm pack --json`'s report the host test reads. */
  PackResult = Schema.fromJsonString(
    Schema.Struct({ filename: Schema.String }),
  ),
  /* The installed plugin's server entry, relative to the install prefix. */
  entrySegments = (npmName: string): readonly string[] => [
    "node_modules",
    ...npmName.split("/"),
    "dist",
    "index.js",
  ],
  /* Run `command` from `checkout` with the inherited environment. */
  inCheckout = (
    checkout: string,
    command: string,
    args: readonly string[],
  ): ReturnType<typeof commands.run> =>
    commands.run({ args, command, cwd: checkout, env: NO_CHANGES }),
  /*
   * Install the requested host CLI into `cli`, check that it reports that
   * version, and return the path of its `opencode` executable.
   */
  installHost = Effect.fn("HostTest.installHost")(function* installHost(
    request: HostInstall,
  ) {
    const executable = (yield* Path.Path).join(
        request.cli,
        "node_modules",
        ".bin",
        "opencode",
      ),
      required = `opencode v${request.version}`,
      version = yield* inCheckout(request.checkout, "npm", [
        "install",
        "--prefix",
        request.cli,
        `@opencode/cli@${request.version}`,
      ]).pipe(
        Effect.andThen(inCheckout(request.checkout, executable, ["--version"])),
        Effect.map((output) => output.trim()),
      )

    if (version !== required) {
      return yield* HostTestError.make({
        message: `The installed OpenCode CLI reports "${version}" instead of "${required}". Ask for an exact host version, X.Y.Z, not a tag or a range.`,
      })
    }

    return executable
  }),
  /*
   * Pack the plugin into `packed`, install the tarball into `install`, and
   * return the URL of the installed plugin's server entry. It packs with
   * pnpm because pnpm, unlike npm, replaces the workspace's `catalog:`
   * versions with real ones in the packed manifest.
   */
  installPlugin = Effect.fn("HostTest.installPlugin")(function* installPlugin(
    request: PluginInstall,
  ) {
    const path = yield* Path.Path,
      pluginEntry = path.join(
        request.install,
        ...entrySegments(request.npmName),
      ),
      report = yield* inCheckout(request.checkout, "pnpm", [
        "pack",
        "--json",
        "--pack-destination",
        request.packed,
      ]).pipe(
        Effect.flatMap((output) => Schema.decodeEffect(PackResult)(output)),
      ),
      url = yield* inCheckout(request.checkout, "npm", [
        "install",
        "--ignore-scripts",
        "--prefix",
        request.install,
        path.resolve(request.packed, report.filename),
      ]).pipe(Effect.andThen(path.toFileUrl(pluginEntry)))

    return url.href
  })

/** Installing the host CLI and the packed plugin into the sandbox. */
/** @internal */
export default Object.freeze({
  entrySegments,
  host: installHost,
  plugin: installPlugin,
})
