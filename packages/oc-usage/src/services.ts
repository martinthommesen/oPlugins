import { Layer, Schema } from "effect"
import Host from "./host.ts"
import type { Plugin } from "@opencode/plugin/effect"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import SidebarSetting from "./sidebar-setting.ts"
import UsageMeter from "./usage-meter.ts"
import UsageTracker from "./usage-tracker.ts"
import claudeUsage from "./claude-usage.ts"
import codexUsage from "./codex-usage.ts"
import pluginOptions from "@oc-lib/plugin-options/plugin-options.ts"

type PluginContext = Plugin.Context

type HostContext = Parameters<typeof Host.fromPlugin>[typeof FIRST]

/** The parts of the host's plugin context the services use. */
interface ServicesHost extends HostContext {
  readonly options: PluginContext["options"]
  readonly storage: PluginContext["storage"]
}

const FIRST = 0,
  /* Rejects every option, since oc-usage has none, naming each one. */
  checkOptions = pluginOptions.decode(Schema.Struct({}), "oc-usage"),
  /*
   * The plugin's services over the host's plugin context. The options are
   * checked before anything else is built, and any option fails them.
   */
  composeServices = (
    context: ServicesHost,
  ): Layer.Layer<SidebarSetting | UsageTracker, PluginOptionsError> => {
    // Each layer's name sorts after the names of the layers it uses.
    const host = Host.fromPlugin(context),
      meter = UsageMeter.live,
      options = Layer.effectDiscard(checkOptions(context.options)),
      setting = SidebarSetting.fromStorage(context.storage),
      tracker = UsageTracker.layer([claudeUsage, codexUsage]).pipe(
        Layer.provide([host, meter]),
      )

    return Layer.merge(setting, tracker).pipe(Layer.provide(options))
  }

/** The plugin's services, assembled around the host's plugin context. */
export default Object.freeze({ layer: composeServices })
