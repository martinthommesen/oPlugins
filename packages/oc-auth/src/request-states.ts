import { Context, Effect, Layer, Option, Struct } from "effect"
import type RequestTransforms from "./request-transforms.ts"
import type claudeCodeCredential from "./claude-code-credential.ts"
import toolAliases from "./tool-aliases.ts"

type TransformedRequest = Effect.Success<
  ReturnType<RequestTransforms["Service"]["request"]>
>

/**
 * How a request was sent, and with what: what unauthorized recovery needs,
 * and the tool aliases that restore its response.
 */
interface RequestState {
  readonly credential: ReturnType<typeof claudeCodeCredential.fromSource>
  /** Every tool alias the request was sent with, including earlier rewrites'. */
  readonly originalByAlias: TransformedRequest["originalByAlias"]
  readonly snapshot: TransformedRequest["snapshot"]
}

/*
 * `state`, keeping every alias `earlier` was sent with as well. A request
 * the plugin rewrites again already carries aliased names, so its own
 * rewrite finds none of them to alias.
 */
const inheriting = (
  state: RequestState,
  earlier: Option.Option<RequestState>,
): RequestState =>
  Struct.assign(state, {
    originalByAlias: toolAliases.merge(
      Option.match(earlier, {
        onNone: () => ({}),
        onSome: (previous) => previous.originalByAlias,
      }),
      state.originalByAlias,
    ),
  })

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
    /**
     * Remember how `request`, rewritten from `rewrittenFrom`, was sent. When
     * the plugin rewrote `rewrittenFrom` too, `request` keeps its aliases.
     */
    readonly remember: (
      request: Request,
      state: RequestState,
      rewrittenFrom: Request,
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
        remember: (request, state, rewrittenFrom) =>
          Effect.sync(() => {
            const earlier = Option.fromUndefinedOr(states.get(rewrittenFrom))

            states.set(request, inheriting(state, earlier))
          }),
      })
    }),
  )
}

export default RequestStates
