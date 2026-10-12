/**
 * The headless host test of a packed plugin, for OpenCode v2.
 *
 * It installs the requested host CLI and the packed plugin into a temporary
 * sandbox with its own config, data, cache, and state directories, then
 * checks that the host starts the plugin under its ID. The plugin's
 * `OC_<WORD>_HEADLESS_HOST_VERSION` picks a host other than the targeted
 * one, and `HEADLESS_KEEP` keeps the sandbox afterwards.
 */
import {
  Array as Arr,
  Console,
  Effect,
  FileSystem,
  Layer,
  Path,
  String as Str,
} from "effect"
import { NodeServices } from "@effect/platform-node"
import checks from "./checks.ts"
import hostFiles from "./host-files.ts"
import install from "./install.ts"
import sandbox from "./sandbox.ts"
import settings from "./settings.ts"

type Layout = Effect.Success<ReturnType<typeof sandbox.layout>>

/** The plugin under test, and how a run picks its host. */
interface PluginUnderTest {
  /** The variable that picks the host version, `OC_<WORD>_HEADLESS_HOST_VERSION`. */
  readonly hostVersionVariable: string
  /** The npm name, such as `@martinthommesen/oc-browser`. */
  readonly npmName: string
  /** The plugin's package directory, as a file URL. */
  readonly packageUrl: string
  /** The ID the host must start the plugin's server entry under. */
  readonly pluginId: string
}

/* The plugin name: the npm name without its scope. */
const bareName = (npmName: string): string =>
    Arr.lastNonEmpty(Str.split(npmName, "/")),
  /* The plugin's package directory, from its file URL. */
  checkoutOf = Effect.fn("HostTest.checkout")(function* checkoutOf(
    packageUrl: string,
  ) {
    const path = yield* Path.Path

    return yield* path.fromFileUrl(new URL(packageUrl))
  }),
  /* The plugin wrapper, the host's plugin file, and the host config. */
  furnishHost = Effect.fn("HostTest.writeHostFiles")(function* furnishHost(
    layout: Layout,
    pluginUrl: string,
    name: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      wrapper = path.join(layout.install, `${name}-wrapper.js`),
      wrapperUrl = yield* path.toFileUrl(wrapper)

    yield* fs.writeFileString(
      wrapper,
      hostFiles.pluginWrapper({ markerPath: layout.marker, pluginUrl }),
    )
    yield* fs.writeFileString(
      path.join(layout.plugins, `${name}.js`),
      hostFiles.pluginEntry(wrapperUrl.href),
    )
    yield* fs.writeFileString(
      path.join(layout.opencodeConfig, "opencode.json"),
      hostFiles.hostConfig,
    )
  }),
  /* The whole host test, inside one sandbox. */
  hostTest = Effect.fn("HostTest.hostTest")(function* hostTest(
    plugin: PluginUnderTest,
  ) {
    const checkout = yield* checkoutOf(plugin.packageUrl),
      config = yield* settings.read(plugin.hostVersionVariable, checkout),
      layout = yield* sandbox
        .acquire(`${bareName(plugin.npmName)}-`, config.keep)
        .pipe(Effect.tap((made) => sandbox.furnish(made))),
      opencode = yield* install.host({
        checkout,
        cli: layout.cli,
        version: config.hostVersion,
      }),
      url = yield* install.plugin({
        checkout,
        install: layout.install,
        npmName: plugin.npmName,
        packed: layout.packed,
      })

    yield* furnishHost(layout, url, bareName(plugin.npmName))
    yield* checks.pluginStarted(
      { env: sandbox.environment(layout), opencode, work: layout.work },
      layout.marker,
      plugin.pluginId,
    )
    yield* Console.log(
      `Packed plugin started on OpenCode ${config.hostVersion}`,
    )
  }, Effect.scoped),
  /* The host test of `plugin` on the Node platform, for `NodeRuntime.runMain`. */
  main = (
    plugin: PluginUnderTest,
  ): Effect.Effect<void, Effect.Error<ReturnType<typeof hostTest>>> =>
    Layer.build(NodeServices.layer).pipe(
      Effect.flatMap((services) =>
        hostTest(plugin).pipe(Effect.provideContext(services)),
      ),
      Effect.scoped,
    )

/** The headless host test, for a plugin's `scripts/test-host.ts`. */
export default Object.freeze({ bareName, main })
