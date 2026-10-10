import { ConfigProvider, Context, Effect, Layer } from "effect"
import { AutoReview } from "./auto-review.ts"
import { ChatGptAuth } from "./chatgpt-auth.ts"
import { CodexResponses } from "./codex-client.ts"
import type { Config } from "effect"
import { DenialBreaker } from "./denial-breaker.ts"
import { FetchHttpClient } from "effect/unstable/http"
import { Host } from "./host.ts"
import { Plugin } from "@opencode/plugin/effect"
import { Reviewer } from "./reviewer.ts"
import { Settings } from "./settings.ts"

/**
 * Wires the plugin's services for one plugin instance.
 * @param {Plugin.Context} context The plugin context OpenCode passed in.
 * @returns {Layer.Layer<AutoReview, Config.ConfigError>} The services, which
 * fail to build when the plugin options are invalid.
 */
const servicesFor = (
  context: Plugin.Context,
): Layer.Layer<AutoReview, Config.ConfigError> => {
  const host = Host.fromPlugin(context)

  const options = ConfigProvider.layer(
    ConfigProvider.fromUnknown(context.options),
  )

  const settings = Settings.layer.pipe(Layer.provide(options))

  const auth = ChatGptAuth.layer.pipe(Layer.provide(host))

  const codex = CodexResponses.layer.pipe(
    Layer.provide([auth, settings, FetchHttpClient.layer]),
  )

  const reviewer = Reviewer.layer.pipe(Layer.provide([codex, settings]))

  const breaker = DenialBreaker.layer.pipe(Layer.provide(settings))

  return AutoReview.layer.pipe(Layer.provide([breaker, host, reviewer]))
}

const plugin = Effect.fn("AutoReviewPlugin")(
  function* autoReviewPlugin(context: Plugin.Context) {
    const services = yield* Layer.build(servicesFor(context))
    const autoReview = Context.get(services, AutoReview)

    yield* context.permission.hook("evaluate", autoReview.evaluate)
  },
  (effect) =>
    Effect.ignore(effect, {
      log: "Error",
      message:
        "opencode-auto-review did not start, so permission prompts are unchanged.",
    }),
)

export default Plugin.define({ effect: plugin, id: "opencode-auto-review" })
