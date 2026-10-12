import { Effect, Schema } from "effect"
import type { PluginOptions } from "@opencode/plugin/options"
import pluginOptions from "@oc-lib/plugin-options/plugin-options.ts"

/** The parts of the host's plugin context this plugin uses. */
interface Host {
  readonly location: { readonly project: { readonly id: string } }
  readonly options: PluginOptions
}

/** The plugin options accepted in `opencode.jsonc`: none yet. */
const Options = Schema.Struct({}),
  /* Rejects every option, since oc-browser has none yet, naming each one. */
  checkOptions = pluginOptions.decode(Options, "oc-browser"),
  /* Starts the server plugin for the location the host opened. */
  setUp = Effect.fn("OcBrowser.setUp")(function* setUp(context: Host) {
    yield* checkOptions(context.options)
    yield* Effect.logInfo("plugin_started").pipe(
      Effect.annotateLogs({ project: context.location.project.id }),
    )
  })

/** The server plugin's setup, which the host runs once per location. */
export default Object.freeze({ setUp })
