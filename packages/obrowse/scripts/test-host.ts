/**
 * Packed-package smoke test for OpenCode v2.
 *
 * Installs the requested host CLI and this package, packed, into a
 * temporary sandbox with its own config, data, cache, and state
 * directories, then checks that the host starts the plugin. Set
 * OBROWSE_HEADLESS_HOST_VERSION to test another host, and HEADLESS_KEEP to
 * keep the sandbox afterwards.
 */
import { Console, Effect, FileSystem, Path } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import checks from "./headless-checks.ts"
import headlessSettings from "./headless-settings.ts"
import hostFiles from "./headless-host-files.ts"
import install from "./headless-install.ts"
import sandbox from "./headless-sandbox.ts"

type Layout = Effect.Success<ReturnType<typeof sandbox.acquire>>

/** The variables the host runs with, over the inherited environment. */
type HostVariable =
  | "OBROWSE_DEBUG"
  | "XDG_CACHE_HOME"
  | "XDG_CONFIG_HOME"
  | "XDG_DATA_HOME"
  | "XDG_STATE_HOME"

/* The plugin wrapper and the host config. */
const furnishHost = Effect.fn("Headless.writeHostFiles")(function* furnishHost(
    layout: Layout,
    plugin: string,
  ) {
    const fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      wrapper = path.join(layout.install, "obrowse-wrapper.js"),
      wrapperUrl = yield* path.toFileUrl(wrapper)

    yield* fs.writeFileString(
      wrapper,
      hostFiles.pluginWrapper({ markerPath: layout.marker, pluginUrl: plugin }),
    )
    yield* fs.writeFileString(
      path.join(layout.plugins, "obrowse.js"),
      hostFiles.pluginEntry(wrapperUrl.href),
    )
    yield* fs.writeFileString(
      path.join(layout.config, "opencode", "opencode.json"),
      hostFiles.hostConfig,
    )
  }),
  /* The host's directories all live in the sandbox, and the plugin logs there. */
  hostEnvironment = (
    layout: Layout,
  ): Readonly<Record<HostVariable, string>> => ({
    OBROWSE_DEBUG: layout.log,
    XDG_CACHE_HOME: layout.cache,
    XDG_CONFIG_HOME: layout.config,
    XDG_DATA_HOME: layout.data,
    XDG_STATE_HOME: layout.state,
  }),
  /* The whole smoke test, inside one sandbox. */
  smokeTest = Effect.gen(function* smokeTest() {
    const config = yield* headlessSettings,
      layout = yield* sandbox
        .acquire(config.keep)
        .pipe(Effect.tap((made) => sandbox.furnish(made))),
      opencode = yield* install.host(layout.cli, config.hostVersion),
      plugin = yield* install.plugin(layout.packed, layout.install)

    yield* furnishHost(layout, plugin)
    yield* checks.pluginStarted(
      { env: hostEnvironment(layout), opencode, work: layout.work },
      layout.marker,
    )
    yield* Console.log(
      `Packed plugin started on OpenCode ${config.hostVersion}`,
    )
  }).pipe(Effect.scoped)

NodeRuntime.runMain(smokeTest.pipe(Effect.provide(NodeServices.layer)))
