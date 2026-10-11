/** Where the plugin wrapper finds the plugin and reports that it started. */
interface WrapperInput {
  readonly markerPath: string
  readonly pluginUrl: string
}

const CONFIG_SCHEMA = "https://opencode.ai/config.json",
  /* The host config: updates off, nothing else changed. */
  HOST_CONFIG = JSON.stringify({ $schema: CONFIG_SCHEMA, update: "disable" }),
  /*
   * The plugin as the host loads it, wrapped. Once the plugin's own set-up
   * has finished, the wrapper appends the plugin's ID to the marker file, so
   * the host test can tell a plugin that started from one the host skipped
   * or that failed. It is written beside the installed plugin, so its
   * `effect` resolves exactly as the plugin's does.
   */
  pluginWrapper = (
    input: WrapperInput,
  ): string => `import plugin from ${JSON.stringify(input.pluginUrl)}
import { Effect } from "effect"
import { appendFileSync } from "node:fs"
export default {
  id: plugin.id,
  effect: (ctx) =>
    plugin.effect(ctx).pipe(
      Effect.andThen(
        Effect.sync(() =>
          appendFileSync(${JSON.stringify(input.markerPath)}, plugin.id + "\\n"),
        ),
      ),
    ),
}
`

/** The files the host test writes for the host. */
export default Object.freeze({
  hostConfig: HOST_CONFIG,
  /* The host's plugin file: the wrapper at `wrapperUrl`, re-exported. */
  pluginEntry: (wrapperUrl: string): string =>
    `export { default } from ${JSON.stringify(wrapperUrl)}\n`,
  pluginWrapper,
})
