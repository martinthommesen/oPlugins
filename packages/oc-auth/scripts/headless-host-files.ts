import { Option } from "effect"
import modelConfig from "#src/model-config.ts"

/** A model the host catalog does not know, declared in the host config. */
interface CustomModel {
  readonly capabilities: {
    readonly input: readonly string[]
    readonly output: readonly string[]
    readonly tools: boolean
  }
  readonly limit: { readonly context: number; readonly output: number }
}

/** The `anthropic` provider entry pointing the host at the mock. */
interface MockProvider {
  readonly models?: Readonly<Record<string, CustomModel>>
  readonly settings: { readonly baseURL: string }
}

/** The `plugins` entry loading the plugin wrapper with the plugin's options. */
interface PluginEntry {
  readonly options: typeof PLUGIN_OPTIONS
  readonly package: string
}

/** The host config the smoke test writes. */
interface HostConfig {
  readonly $schema: string
  readonly agents?: { readonly title: { readonly model: string } }
  readonly plugins: readonly PluginEntry[]
  readonly providers?: { readonly anthropic: MockProvider }
  readonly update: string
}

/** What the host config depends on. */
interface HostConfigInput {
  readonly customModel: boolean
  /** The mock's base URL, when the run is offline. */
  readonly mockBaseUrl: Option.Option<string>
  readonly model: string
  /** The plugin wrapper's package directory. */
  readonly plugin: string
}

/** Where the plugin wrapper finds the plugin and leaves the model list. */
interface WrapperInput {
  readonly modelsPath: string
  readonly offline: boolean
  readonly pluginUrl: string
}

const CONFIG_SCHEMA = "https://opencode.ai/config.json",
  CUSTOM_CONTEXT_TOKENS = 1_000_000,
  CUSTOM_OUTPUT_TOKENS = 128_000,
  /*
   * The plugin's options, passed the way a user passes them: the identity
   * the mock checks for, so the wire shows that options from the host
   * config reach the plugin. They are the defaults, so a live run sends
   * what Claude Code sends.
   */
  PLUGIN_OPTIONS = {
    cliVersion: modelConfig.ccVersion,
    entrypoint: "sdk-cli",
  },
  PROVIDER_PREFIX = /^anthropic\//u,
  /*
   * A `security` stand-in: an empty Keychain, and "not found" for anything
   * else, so the plugin only sees the sandbox's credentials file.
   */
  SECURITY_STUB = `#!/bin/sh
if [ "$1" = "dump-keychain" ]; then exit 0; fi
exit 44
`,
  /* The mock provider, with `model` declared when it is a custom model. */
  anthropicProvider = (
    input: HostConfigInput,
    baseURL: string,
  ): MockProvider => {
    const settings = { baseURL }

    if (!input.customModel) {
      return { settings }
    }

    return {
      models: {
        [input.model.replace(PROVIDER_PREFIX, "")]: {
          capabilities: {
            input: ["text", "image"],
            output: ["text"],
            tools: true,
          },
          limit: {
            context: CUSTOM_CONTEXT_TOKENS,
            output: CUSTOM_OUTPUT_TOKENS,
          },
        },
      },
      settings,
    }
  },
  /*
   * The host config: updates off, the plugin wrapper loaded with the
   * plugin's options and, offline, the `anthropic` provider pointed at the
   * mock, with title requests on the model under test.
   */
  hostConfig = (input: HostConfigInput): string => {
    const plugins = [{ options: PLUGIN_OPTIONS, package: input.plugin }]

    return JSON.stringify(
      Option.match(input.mockBaseUrl, {
        onNone: (): HostConfig => ({
          $schema: CONFIG_SCHEMA,
          plugins,
          update: "disable",
        }),
        onSome: (baseURL): HostConfig => ({
          $schema: CONFIG_SCHEMA,
          agents: { title: { model: input.model } },
          plugins,
          providers: { anthropic: anthropicProvider(input, baseURL) },
          update: "disable",
        }),
      }),
    )
  },
  /*
   * The plugin as the host loads it, wrapped. Offline, a hook tags each
   * Anthropic request with its kind so the mock can tell the agent loop from
   * title requests. Standalone API reads do not activate plugins in the
   * supported hosts, but the `auth` and `run` commands do, as a normal
   * client does. So the wrapper reads the host's models after the plugin
   * has started and leaves them where the smoke test checks their pricing. It is written beside the
   * installed plugin, so its `effect` resolves exactly as the plugin's does
   * on any host, whether or not the host provides one to its plugins. It is
   * the entry of a package directory, because the host config names local
   * plugins by directory.
   */
  pluginWrapper = (
    input: WrapperInput,
  ): string => `import plugin from ${JSON.stringify(input.pluginUrl)}
import { Effect } from "effect"
import { writeFileSync } from "node:fs"
export default {
  id: plugin.id,
  effect: (ctx) =>
    Effect.gen(function* () {
      yield* plugin.effect(ctx)
      if (${String(input.offline)}) {
        yield* ctx.session.hook(
          "http.request",
          (event) =>
            Effect.sync(() => {
              event.request.headers.set("x-claude-auth-test-kind", event.kind)
            }),
          { providerID: "anthropic" },
        )
      }
      const { data: models } = yield* Effect.orDie(ctx.model.list())
      yield* Effect.sync(() =>
        writeFileSync(
          ${JSON.stringify(input.modelsPath)},
          JSON.stringify(models.map(({ providerID, cost }) => ({ providerID, cost }))),
        ),
      )
    }),
}
`

/** The files the smoke test writes for the host. */
export default Object.freeze({
  hostConfig,
  /** The manifest of the wrapper's package directory. */
  pluginManifest: JSON.stringify({
    exports: "./index.js",
    name: "claude-auth-wrapper",
    private: true,
    type: "module",
  }),
  pluginWrapper,
  securityStub: SECURITY_STUB,
})
