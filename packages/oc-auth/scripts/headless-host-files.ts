import { Option } from "effect"

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

/** The host config the smoke test writes. */
interface HostConfig {
  readonly $schema: string
  readonly agents?: { readonly title: { readonly model: string } }
  readonly providers?: { readonly anthropic: MockProvider }
  readonly update: string
}

/** What the host config depends on. */
interface HostConfigInput {
  readonly customModel: boolean
  /** The mock's base URL, when the run is offline. */
  readonly mockBaseUrl: Option.Option<string>
  readonly model: string
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
   * The host config: updates off and, offline, the `anthropic` provider
   * pointed at the mock, with title requests on the model under test.
   */
  hostConfig = (input: HostConfigInput): string =>
    JSON.stringify(
      Option.match(input.mockBaseUrl, {
        onNone: (): HostConfig => ({
          $schema: CONFIG_SCHEMA,
          update: "disable",
        }),
        onSome: (baseURL): HostConfig => ({
          $schema: CONFIG_SCHEMA,
          agents: { title: { model: input.model } },
          providers: { anthropic: anthropicProvider(input, baseURL) },
          update: "disable",
        }),
      }),
    ),
  /*
   * The plugin as the host loads it, wrapped. Offline, a hook tags each
   * Anthropic request with its kind so the mock can tell the agent loop from
   * title requests. Standalone API reads do not activate plugins in the
   * supported hosts; auth/run commands do, as a normal client does. So the
   * wrapper reads the host's models after the plugin has started and leaves
   * them where the smoke test checks their pricing. It is written beside the
   * installed plugin, so its `effect` resolves exactly as the plugin's does
   * on any host, whether or not the host provides one to its plugins.
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
  /* The host's plugin file: the wrapper at `wrapperUrl`, re-exported. */
  pluginEntry: (wrapperUrl: string): string =>
    `export { default } from ${JSON.stringify(wrapperUrl)}\n`,
  pluginWrapper,
  securityStub: SECURITY_STUB,
})
