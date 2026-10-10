import ActiveCredential from "./active-credential.ts"
import { Layer } from "effect"
import PluginRig from "./plugin-rig.test-support.ts"
import RequestStates from "./request-states.ts"
import SessionAliases from "./session-aliases.ts"
import pluginPlatform from "./plugin-platform.test-support.ts"

const FIRST = 0,
  SECOND = 1,
  /*
   * The plugin's own state and request handling over the rig scripted by
   * `script`, with `accounts` registered in the stores.
   */
  pluginServices = (
    script: Parameters<typeof PluginRig.layer>[typeof FIRST],
    accounts: Parameters<typeof PluginRig.layer>[typeof SECOND],
  ): Layer.Layer<
    | ActiveCredential
    | Layer.Success<ReturnType<typeof PluginRig.layer>>
    | Layer.Success<typeof pluginPlatform>
    | RequestStates
    | SessionAliases
  > =>
    Layer.mergeAll(
      ActiveCredential.layer,
      RequestStates.layer,
      SessionAliases.layer,
    ).pipe(
      Layer.provideMerge(PluginRig.layer(script, accounts)),
      Layer.provideMerge(pluginPlatform),
    )

export default pluginServices
