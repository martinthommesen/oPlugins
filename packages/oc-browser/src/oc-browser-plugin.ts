import { Effect, Record, Schema } from "effect"
import InvalidOptions from "./invalid-options-error.ts"
import type { PluginOptions } from "@opencode/plugin/options"

/** The parts of the host's plugin context this plugin uses. */
interface Host {
  readonly location: { readonly project: { readonly id: string } }
  readonly options: PluginOptions
}

/*
 * The plugin options accepted in `opencode.jsonc`: none yet, so every
 * option is unknown. Schema's excess-property check skips a struct with no
 * fields, so this check names each option instead.
 */
const Options = Schema.Record(Schema.String, Schema.Json).check(
    Schema.makeFilter((options) =>
      Record.keys(options).map((option) => ({
        issue: "Unknown option",
        path: [option],
      })),
    ),
  ),
  /* Fails with every problem in `options`, so a typo cannot pass unnoticed. */
  checkOptions = (
    options: PluginOptions,
  ): Effect.Effect<typeof Options.Type, InvalidOptions> =>
    Schema.decodeEffect(Options)(options, { errors: "all" }).pipe(
      Effect.mapError((failure) => InvalidOptions.fromIssue(failure.issue)),
    ),
  /* Start the plugin for the project the host opened. */
  setUp = Effect.fn("OcBrowser.setUp")(function* setUp(context: Host) {
    yield* checkOptions(context.options)
    yield* Effect.logInfo("plugin_started").pipe(
      Effect.annotateLogs({ project: context.location.project.id }),
    )
  })

/** Setting the plugin up inside the host. */
export default Object.freeze({ setUp })
