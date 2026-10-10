import { ConfigProvider, Context, Effect, Layer } from "effect"
import AutoReview from "./auto-review.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import CodexResponses from "./codex-client.ts"
import type { Config } from "effect"
import DenialBreaker from "./denial-breaker.ts"
import { FetchHttpClient } from "effect/unstable/http"
import Host from "./host.ts"
import { Plugin } from "@opencode/plugin/effect"
import Reviewer from "./reviewer.ts"
import Settings from "./settings.ts"

/* The plugin's services over the host's plugin context and options. */
const composeServices = (
    context: Plugin.Context,
  ): Layer.Layer<AutoReview, Config.ConfigError> => {
    const host = Host.fromPlugin(context),
      options = ConfigProvider.layer(
        ConfigProvider.fromUnknown(context.options),
      ),
      settings = Settings.layer.pipe(Layer.provide(options)),
      signIn = ChatGptAuth.layer.pipe(Layer.provide(host)),
      /* The denial breaker. */
      strikes = DenialBreaker.layer.pipe(Layer.provide(settings)),
      /* The Codex backend client. */
      upstream = CodexResponses.layer.pipe(
        Layer.provide([signIn, settings, FetchHttpClient.layer]),
      ),
      /* The reviewer that vets each request. */
      vetting = Reviewer.layer.pipe(Layer.provide([upstream, settings]))

    return AutoReview.layer.pipe(
      Layer.provide([strikes, host, vetting, settings]),
    )
  },
  /*
   * Routes the host's permission prompts through the reviewer. A failure to
   * start leaves the prompts as they are.
   */
  plugin = Effect.fn("AutoReviewPlugin")(
    function* autoReviewPlugin(context: Plugin.Context) {
      const autoReview = Context.get(
        yield* Layer.build(composeServices(context)),
        AutoReview,
      )

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
