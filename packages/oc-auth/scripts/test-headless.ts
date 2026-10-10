/**
 * Manual packed-package smoke test for OpenCode v2.
 *
 * Pass --offline to test plugin loading, import, pricing, and a streamed
 * read-tool round trip with a fake credential and a local mock API, without
 * reading real credentials or contacting Anthropic.
 *
 * By default this copies one valid Claude Code account into an isolated source
 * and verifies package loading, automatic import, account labeling, native
 * catalog pricing, and one real read-tool round trip. It never refreshes the
 * copied token because doing so would invalidate its original source.
 *
 * To exercise near-expiry refresh and write-back, set
 * OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR to a disposable Claude config
 * directory. Its refresh token will rotate and the resulting credentials will
 * remain in that directory.
 */
import {
  Console,
  Crypto,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
} from "effect"
import { NodeRuntime } from "@effect/platform-node"
import checks from "./headless-checks.ts"
import credentials from "./headless-credentials.ts"
import headlessServices from "./headless-services.ts"
import headlessSettings from "./headless-settings.ts"
import hostFiles from "./headless-host-files.ts"
import install from "./headless-install.ts"
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
  | "ANTHROPIC_BETA_FLAGS"
  | "ANTHROPIC_CLI_VERSION"
  | "ANTHROPIC_USER_AGENT"
  | "CLAUDE_AUTH_DEBUG"
  | "CLAUDE_CODE_ENTRYPOINT"
  | "CLAUDE_CONFIG_DIR"
  | "OC_AUTH_SECURITY_BIN"
  | "PATH"
  | "XDG_CACHE_HOME"
  | "XDG_CONFIG_HOME"
  | "XDG_DATA_HOME"
  | "XDG_STATE_HOME"

/* What an offline run reports when it passes. */
const asOfflinePass = (config: Settings): string => {
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
  /* The plugin wrapper, the host config, and the file the model reads. */
  furnishHost = Effect.fn("Headless.writeHostFiles")(function* furnishHost(
    setup: HostSetup,
  ) {
    const fs = yield* FileSystem.FileSystem,
      mockBaseUrl = setup.mock.pipe(Option.map((server) => server.baseURL)),
      path = yield* Path.Path,
      wrapper = path.join(setup.layout.install, "claude-auth-wrapper.js"),
      wrapperUrl = yield* path.toFileUrl(wrapper)

    yield* fs.writeFileString(
      wrapper,
      hostFiles.pluginWrapper({
        modelsPath: setup.layout.models,
        offline: setup.config.offline,
        pluginUrl: setup.plugin,
      }),
    )
    yield* fs.writeFileString(
      path.join(setup.layout.plugins, "claude-auth.js"),
      hostFiles.pluginEntry(wrapperUrl.href),
    )
    yield* fs.writeFileString(
      path.join(setup.layout.config, "opencode", "opencode.json"),
      hostFiles.hostConfig({
        customModel: setup.config.customModel,
        mockBaseUrl,
        model: setup.config.model,
      }),
    )
    yield* fs.writeFileString(setup.layout.smoke, setup.marker)
  }),
  /*
   * The environment the host runs with, as changes to the inherited one.
   * The plugin reads the four cleared variables to override what it sends.
   * Inherited from the developer's shell (Claude Code itself sets
   * CLAUDE_CODE_ENTRYPOINT), they would change the wire values the mock
   * checks against. The plugin decodes them with `Config`, which reads an
   * empty variable as unset.
   */
  hostEnvironment = (
    layout: Layout,
    config: Settings,
    source: Source,
  ): Readonly<Record<HostVariable, string>> => ({
    ANTHROPIC_BETA_FLAGS: "",
    ANTHROPIC_CLI_VERSION: "",
    ANTHROPIC_USER_AGENT: "",
    CLAUDE_AUTH_DEBUG: layout.log,
    CLAUDE_CODE_ENTRYPOINT: "",
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
      layout = yield* sandbox
        .acquire(config.keep)
        .pipe(
          Effect.tap((made) => sandbox.furnish(made, hostFiles.securityStub)),
        ),
      marker = yield* newMarker,
      mock = yield* mockAnthropic
        .start(marker, layout.smoke)
        .pipe(Effect.when(Effect.succeed(config.offline))),
      opencode = yield* install.host(layout.cli, config.hostVersion),
      plugin = yield* install.plugin(layout.packed, layout.install),
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

NodeRuntime.runMain(
  Layer.build(headlessServices).pipe(
    Effect.flatMap((services) =>
      smokeTest.pipe(Effect.provideContext(services)),
    ),
    Effect.scoped,
  ),
)
