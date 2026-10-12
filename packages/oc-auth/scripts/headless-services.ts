import ClaudeCodeStores from "#src/claude-code-stores.ts"
import Environment from "#src/environment.ts"
import { Layer } from "effect"
import { NodeServices } from "@effect/platform-node"

/** The Claude Code credential stores, and the Node platform. */
const headlessServices = ClaudeCodeStores.layer.pipe(
  Layer.provideMerge(Environment.layer),
  Layer.provideMerge(NodeServices.layer),
)

/** @internal */
export default headlessServices
