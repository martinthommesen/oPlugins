import { Context, Effect, Layer } from "effect"
import AutoReview from "./auto-review.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import CodexResponses from "./codex-client.ts"
import DenialBreaker from "./denial-breaker.ts"
import { FetchHttpClient } from "effect/unstable/http"
import Host from "./host.ts"
import type { Plugin } from "@opencode/plugin/effect"
import Reviewer from "./reviewer.ts"
import type { Scope } from "effect"
import Settings from "./settings.ts"

type PluginContext = Plugin.Context

type HostContext = Parameters<typeof Host.fromPlugin>[typeof FIRST]

type PluginOptionsError = Layer.Error<ReturnType<typeof Settings.fromOptions>>

/** The parts of the host's plugin context this plugin uses. */
interface PluginHost extends HostContext {
  readonly options: PluginContext["options"]
  readonly permission: Pick<PluginContext["permission"], "hook">
}

const FIRST = 0,
  /* The plugin's services over the host's plugin context and options. */
  composeServices = (
    context: PluginHost,
  ): Layer.Layer<AutoReview, PluginOptionsError> => {
    const host = Host.fromPlugin(context),
      settings = Settings.fromOptions(context.options),
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
