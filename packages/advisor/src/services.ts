import { Advisor } from "./advisor.ts"
import type { Host } from "./host.ts"
import { Layer } from "effect"
import type { PluginOptions } from "@opencode/plugin/options"
import { PreferenceStore } from "./preferences.ts"
import { Settings } from "./settings.ts"
import type { StorageDomain } from "@opencode/plugin/effect/storage"

type Services = Advisor | Host | PreferenceStore | Settings

/**
 * Assembles the plugin's services around a host.
 * @param {Layer.Layer<Host>} host The OpenCode server, or a stand-in.
 * @param {PluginOptions} options The plugin options.
 * @param {StorageDomain} storage The plugin's durable storage.
 * @returns {Layer.Layer<Services>} The services.
 */
const servicesLayer = (
  host: Layer.Layer<Host>,
  options: PluginOptions,
  storage: StorageDomain,
): Layer.Layer<Services> => {
  const foundation = Layer.merge(host, Settings.fromOptions(options))

  const preferences = PreferenceStore.fromStorage(storage).pipe(
    Layer.provideMerge(foundation),
  )

  return Advisor.layer.pipe(Layer.provideMerge(preferences))
}

export { servicesLayer }

export type { Services }
