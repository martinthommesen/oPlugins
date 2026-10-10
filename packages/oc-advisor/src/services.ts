import Advisor from "./advisor.ts"
import type Host from "./host.ts"
import type InvalidOptions from "./invalid-options-error.ts"
import { Layer } from "effect"
import type { PluginOptions } from "@opencode/plugin/options"
import PreferenceStore from "./preference-store.ts"
import Settings from "./settings.ts"
import type { StorageDomain } from "@opencode/plugin/effect/storage"

type Services = Advisor | Host | PreferenceStore | Settings

/*
 * Assembles the plugin's services around a host (the OpenCode server, or a
 * stand-in), the plugin options, and the plugin's durable storage. Invalid
 * options fail it.
 */
const servicesLayer = (
  host: Layer.Layer<Host>,
  options: PluginOptions,
  storage: StorageDomain,
): Layer.Layer<Services, InvalidOptions> => {
  const foundation = Layer.merge(host, Settings.fromOptions(options)),
    preferences = PreferenceStore.fromStorage(storage).pipe(
      Layer.provideMerge(foundation),
    )

  return Advisor.layer.pipe(Layer.provideMerge(preferences))
}

/** The plugin's services, assembled around a host. */
export default Object.freeze({ layer: servicesLayer })
