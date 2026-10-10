import DebugLog from "./debug-log.ts"
import { Effect } from "effect"

/** The parts of the host's plugin context this plugin uses. */
interface Host {
  readonly location: { readonly directory: string }
}

/* Start the plugin for the project the host opened. */
const setUp = Effect.fn("Obrowse.setUp")(function* setUp(context: Host) {
  const log = yield* DebugLog

  yield* log.log("plugin_started", { directory: context.location.directory })
})

/** Setting the plugin up inside the host. */
export default Object.freeze({ setUp })
