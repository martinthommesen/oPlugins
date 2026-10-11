import { Console, Crypto, Effect, FileSystem, Option, Path } from "effect"
import checks from "./headless-checks.ts"
import credentials from "./headless-credentials.ts"
import headlessSettings from "./headless-settings.ts"
import hostFiles from "./headless-host-files.ts"
import install from "@oc-lib/host-test/install.ts"
import mockAnthropic from "./mock-anthropic.ts"
import sandbox from "./headless-sandbox.ts"

type Layout = Effect.Success<ReturnType<typeof sandbox.acquire>>

type Settings = Readonly<Effect.Success<typeof headlessSettings>>

type Source = Readonly<Effect.Success<ReturnType<typeof credentials.prepare>>>

type Mock = Readonly<Effect.Success<ReturnType<typeof mockAnthropic.start>>>

/** What the host files are written from. */
interface HostSetup {
  readonly config: Settings
  readonly layout: Layout
  readonly marker: string
  readonly mock: Option.Option<Mock>
  readonly plugin: string
}

/** The variables the host runs with, over the inherited environment. */
type HostVariable =
  | "CLAUDE_CONFIG_DIR"
  | "OC_AUTH_SECURITY_BIN"
  | "PATH"
  | "XDG_CACHE_HOME"
  | "XDG_CONFIG_HOME"
  | "XDG_DATA_HOME"
  | "XDG_STATE_HOME"

const NPM_NAME = "@martinthommesen/oc-auth",
  /* What an offline run reports when it passes. */
  asOfflinePass = (config: Settings): string => {
    const passed = `Packed OpenCode ${config.hostVersion} offline tool round trip passed with ${config.model}`

    if (config.customModel) {
      return `${passed} (custom model)`
    }

    return passed
  },
  /* Report success, after the mock's verdict or the write-back check. */
  conclude = Effect.fn("Headless.conclude")(function* conclude(
    config: Settings,
    source: Source,
    mock: Option.Option<Mock>,
  ) {
    const offlinePass = Console.log(asOfflinePass(config)),
      onlinePass = Console.log(
        `Packed OpenCode v2 smoke test passed with ${config.model}`,
      )

    yield* Option.match(mock, {
      onNone: () =>
        credentials.checkWriteBack(source).pipe(Effect.andThen(onlinePass)),
      onSome: (server) => server.verify.pipe(Effect.andThen(offlinePass)),
    })
  }),
  /*
   * The plugin wrapper's package, the host config that loads it with the
   * plugin's options, and the file the model reads.
   */
  furnishHost = Effect.fn("Headless.writeHostFiles")(function* furnishHost(
    setup: HostSetup,
  ) {
    const fs = yield* FileSystem.FileSystem,
      mockBaseUrl = setup.mock.pipe(Option.map((server) => server.baseURL)),
      path = yield* Path.Path

    yield* fs.writeFileString(
      path.join(setup.layout.plugin, "index.js"),
      hostFiles.pluginWrapper({
        modelsPath: setup.layout.models,
        offline: setup.config.offline,
        pluginUrl: setup.plugin,
      }),
    )
    yield* fs.writeFileString(
      path.join(setup.layout.plugin, "package.json"),
      hostFiles.pluginManifest,
    )
    yield* fs.writeFileString(
      path.join(setup.layout.opencodeConfig, "opencode.json"),
      hostFiles.hostConfig({
        customModel: setup.config.customModel,
        mockBaseUrl,
        model: setup.config.model,
        plugin: setup.layout.plugin,
      }),
    )
    yield* fs.writeFileString(setup.layout.smoke, setup.marker)
  }),
  /*
   * The environment the host runs with, as changes to the inherited one:
   * the sandbox's Claude config directory, `security` stand-in, and
   * OpenCode directories. The plugin's settings are options in the host
   * config, so the developer's shell cannot change what it sends.
   */
  hostEnvironment = (
    layout: Layout,
    config: Settings,
    source: Source,
  ): Readonly<Record<HostVariable, string>> => ({
    CLAUDE_CONFIG_DIR: source.configDir,
    OC_AUTH_SECURITY_BIN: layout.security,
    PATH: `${layout.bin}:${config.path}`,
    XDG_CACHE_HOME: layout.cache,
    XDG_CONFIG_HOME: layout.config,
    XDG_DATA_HOME: layout.data,
    XDG_STATE_HOME: layout.state,
  }),
  /* A value the model can only return by reading the smoke file. */
  newMarker = Effect.gen(function* newMarker() {
    const crypto = yield* Crypto.Crypto,
      uuid = yield* crypto.randomUUIDv4

    return `HEADLESS_${uuid.replaceAll("-", "")}`
  }),
  /* The whole smoke test, inside one sandbox. */
  smokeTest = Effect.gen(function* smokeTest() {
    const config = yield* headlessSettings,
      layout = yield* sandbox.acquire(config.keep, hostFiles.securityStub),
      marker = yield* newMarker,
      mock = yield* mockAnthropic
        .start(marker, layout.smoke)
        .pipe(Effect.when(Effect.succeed(config.offline))),
      opencode = yield* install.host({
        checkout: config.checkout,
        cli: layout.cli,
        version: config.hostVersion,
      }),
      plugin = yield* install.plugin({
        checkout: config.checkout,
        install: layout.install,
        npmName: NPM_NAME,
        packed: layout.packed,
      }),
      source = yield* credentials.prepare(layout.root, config),
      target = {
        env: hostEnvironment(layout, config, source),
        opencode,
        work: layout.work,
      }

    yield* furnishHost({ config, layout, marker, mock, plugin })
    yield* checks.autoImport(target)
    yield* checks.accountLabel(target)
    yield* checks.nativePricing(layout.models)
    yield* checks.toolRoundTrip(target, {
      model: config.model,
      sentinel: marker,
      smoke: layout.smoke,
    })
    yield* conclude(config, source, mock)
  }).pipe(Effect.scoped)

export default smokeTest
