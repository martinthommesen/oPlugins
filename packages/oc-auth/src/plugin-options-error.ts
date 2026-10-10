import { Schema } from "effect"

/**
 * The plugin's options in `opencode.jsonc` are invalid. The message names
 * every offending option and what is wrong with it, and the plugin does not
 * start.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class PluginOptionsError extends Schema.TaggedError<PluginOptionsError>()(
  "PluginOptionsError",
  { message: Schema.String },
) {}

export default PluginOptionsError
