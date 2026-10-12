import { Context, Effect, Layer, Option } from "effect"
import type RequestTransforms from "./request-transforms.ts"
import type claudeCodeCredential from "./claude-code-credential.ts"

type Snapshot = Effect.Success<
  ReturnType<RequestTransforms["Service"]["request"]>
>["snapshot"]

/** What unauthorized recovery needs: how a request was sent, and with what. */
interface RequestState {
  readonly credential: ReturnType<typeof claudeCodeCredential.fromSource>
  readonly snapshot: Snapshot
}

/**
 * How each request this plugin rewrote was sent, keyed by the `Request` the
 * response hook is handed. Weakly held, so a request the host drops takes its
 * snapshot, body included, with it.
 */
class RequestStates extends Context.Service<
  RequestStates,
  {
    /** How `request` was sent, if this plugin rewrote it. */
    readonly lookup: (
      request: Request,
    ) => Effect.Effect<Option.Option<RequestState>>
    /** Remember how `request` was sent. */
    readonly remember: (
      request: Request,
      state: RequestState,
    ) => Effect.Effect<void>
  }
>()("@martinthommesen/oc-auth/request-states/RequestStates") {
  /** Request states for the plugin's lifetime. */
  public static readonly layer: Layer.Layer<RequestStates> = Layer.effect(
    RequestStates,
    Effect.sync(() => {
      const states = new WeakMap<Request, RequestState>()

      return RequestStates.of({
        lookup: (request) =>
          Effect.sync(() => Option.fromUndefinedOr(states.get(request))),
        remember: (request, state) =>
          Effect.sync(() => {
            states.set(request, state)
          }),
      })
    }),
  )
}

export default RequestStates
