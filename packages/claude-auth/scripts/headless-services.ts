import { ConfigProvider, Layer } from "effect"
import ClaudeCodeStores from "#src/claude-code-stores.ts"
import DebugLog from "#src/debug-log.ts"
import Environment from "#src/environment.ts"
import { NodeServices } from "@effect/platform-node"

/*
 * The plugin's own debug log is off in this process: account discovery must
 * not truncate a log the developer's `CLAUDE_AUTH_DEBUG` names.
 */
const QuietPluginLog = ConfigProvider.layerAdd(
    ConfigProvider.fromUnknown({ CLAUDE_AUTH_DEBUG: "0" }),
    { asPrimary: true },
  ),
  /** The Claude Code credential stores, and the Node platform. */
  headlessServices = ClaudeCodeStores.layer.pipe(
    Layer.provideMerge(DebugLog.layer),
    Layer.provideMerge(Environment.layer),
    Layer.provide(QuietPluginLog),
    Layer.provideMerge(NodeServices.layer),
  )

export default headlessServices
