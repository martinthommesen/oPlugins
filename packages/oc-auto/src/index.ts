import { Context, Effect, Layer } from "effect"
import AutoReview from "./auto-review.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import CodexResponses from "./codex-client.ts"
import DenialBreaker from "./denial-breaker.ts"
import { FetchHttpClient } from "effect/http"
import Host from "./host.ts"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import Reviewer from "./reviewer.ts"
import type { Scope } from "effect"

type HostContext = Parameters<typeof Host.fromPlugin>[typeof FIRST]

type PluginOptionsError = Layer.Error<
  ReturnType<typeof PluginOptions.fromOptions>
>

/** The parts of the host's plugin context this plugin uses. */
interface PluginHost extends HostContext {
  readonly options: Plugin.Context["options"]
  readonly permission: Pick<Plugin.Context["permission"], "hook">
}

const FIRST = 0,
  /* The plugin's services over the host's plugin context and options. */
  composeServices = (
    context: PluginHost,
  ): Layer.Layer<AutoReview, PluginOptionsError> => {
    // Each layer's name sorts after the names of the layers it uses.
    const host = Host.fromPlugin(context),
      options = PluginOptions.fromOptions(context.options),
      signIn = ChatGptAuth.layer.pipe(Layer.provide(host)),
      strikes = DenialBreaker.layer.pipe(Layer.provide(options)),
      upstream = CodexResponses.layer.pipe(
        Layer.provide([signIn, options, FetchHttpClient.layer]),
      ),
      vetting = Reviewer.layer.pipe(Layer.provide([upstream, options]))

    return AutoReview.layer.pipe(
      Layer.provide([strikes, host, vetting, options]),
    )
  },
  /* Routes the host's permission prompts through the reviewer. */
  install = Effect.fn("AutoReviewPlugin.install")(function* install(
    context: PluginHost,
  ) {
    const autoReview = Context.get(
      yield* Layer.build(composeServices(context)),
      AutoReview,
    )

    yield* context.permission.hook("evaluate", autoReview.evaluate)
  }),
  /*
   * Sends permission prompts to a reviewer model. Invalid options are a
   * defect the host reports as a failed plugin, which leaves permission
   * prompts unchanged.
   */
  plugin = {
    effect: (context: PluginHost): Effect.Effect<void, never, Scope.Scope> =>
      install(context).pipe(Effect.orDie),
    id: "martinthommesen.oc-auto",
  } satisfies Plugin.Plugin

export default plugin
