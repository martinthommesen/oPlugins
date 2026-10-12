import ActiveCredential from "./active-credential.ts"
import AnthropicFetch from "./anthropic-fetch.ts"
import { Layer } from "effect"
import RequestStates from "./request-states.ts"
import RequestTransforms from "./request-transforms.ts"
import SessionAliases from "./session-aliases.ts"
import refreshServices from "./refresh-services.ts"

/**
 * Every service the plugin runs on, over Node, given the plugin's options:
 * the request path's services over credential refresh. Built into the
 * plugin's scope, so their state and background work end when the host
 * unloads it.
 */
const services = Layer.mergeAll(
  ActiveCredential.layer,
  AnthropicFetch.layer,
  RequestStates.layer,
  RequestTransforms.layer,
  SessionAliases.layer,
).pipe(Layer.provideMerge(refreshServices))

/** @internal */
export default services
