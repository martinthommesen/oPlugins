import Advisor from "./advisor.ts"
import type Host from "./host.ts"
import { Layer } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import PreferenceStore from "./preference-store.ts"
import type { StorageDomain } from "@opencode/plugin/effect/storage"

type Services = Advisor | Host | PluginOptions | PreferenceStore

/*
 * Assembles the plugin's services around a host layer (OpenCode's, or a fake
 * in tests), the plugin options, and the plugin's durable storage. Invalid
 * options fail it.
 */
const servicesLayer = (
  host: Layer.Layer<Host>,
  options: Plugin.Context["options"],
  storage: StorageDomain,
): Layer.Layer<Services, PluginOptionsError> => {
  const foundation = Layer.merge(host, PluginOptions.fromOptions(options)),
    preferences = PreferenceStore.fromStorage(storage).pipe(
      Layer.provideMerge(foundation),
    )

  return Advisor.layer.pipe(Layer.provideMerge(preferences))
}

/** The plugin's services, assembled around a host. */
export default Object.freeze({ layer: servicesLayer })
