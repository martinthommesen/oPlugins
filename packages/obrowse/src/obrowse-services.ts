import DebugLog from "./debug-log.ts"
import Environment from "./environment.ts"
import { Layer } from "effect"
import nodePlatform from "./node-platform.ts"

/**
 * Every service the plugin runs on, over Node. Built into the plugin's
 * scope, so their state and background work end when the host unloads it.
 */
const services = DebugLog.layer.pipe(
  Layer.provideMerge(Environment.layer),
  Layer.provideMerge(nodePlatform),
)

export default services
