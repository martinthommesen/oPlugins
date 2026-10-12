import { Effect, Option } from "effect"
import ActiveCredential from "./active-credential.ts"
import type { Plugin } from "@opencode/plugin/effect"
import RequestStates from "./request-states.ts"
import RequestTransforms from "./request-transforms.ts"
import SessionAliases from "./session-aliases.ts"
import type { SessionHttpResponse } from "@opencode/plugin/effect/session"
import claudeCodeCredential from "./claude-code-credential.ts"
import pluginLog from "./plugin-log.ts"
import recovery from "./unauthorized-recovery.ts"

type Hook = Plugin.Context["session"]["hook"]

type RequestState = Option.Option.Value<
  Effect.Success<ReturnType<RequestStates["Service"]["lookup"]>>
>

type ContextEvent = Parameters<
  RequestTransforms["Service"]["context"]
>[typeof FIRST]

type RequestEvent = Parameters<
  RequestTransforms["Service"]["request"]
>[typeof FIRST]

/** What the session hooks use, captured once and handed to every callback. */
type Hooks =
  | ActiveCredential
  | RequestStates
  | RequestTransforms
  | SessionAliases
  | Effect.Services<ReturnType<typeof recovery.recover>>

/* The hooks that rewrite a model call's context, and the kind each keys. */
const CONTEXT_HOOKS = [
    ["context", "primary"],
    ["compaction", "compaction"],
    ["generate", "generate"],
    ["title", "title"],
  ] as const,
  FIRST = 0,
  ONLY_ANTHROPIC = Object.freeze({
    providerID: claudeCodeCredential.INTEGRATION_ID,
  }),
  PRIMARY_KIND = "primary",
  UNAUTHORIZED = 401,
  /*
   * The response the caller gets: a 401 on a request this plugin sent is
   * recovered from; anything else, or a request it did not send, passes.
   */
  answerFor = (
    response: Response,
    state: Option.Option<RequestState>,
  ): Effect.Effect<Response, never, Hooks> => {
    if (Option.isSome(state) && response.status === UNAUTHORIZED) {
      return recovery.recover(response, state.value)
    }

    return Effect.succeed(response)
  },
  // The host types `kind` as required, but an event can arrive without it.
  kindOf = (event: { readonly kind: string }): string =>
    Option.getOrElse(Option.fromUndefinedOr(event.kind), () => PRIMARY_KIND),
  /*
   * The aliases that restore a response: those its request was sent with,
   * or, when the host handed back a Request other than the one the request
   * hook produced, the session's. None when neither is known, because the
   * request saw no credential of ours.
   */
  knownAliases = Effect.fn("SessionHooks.knownAliases")(function* knownAliases(
    event: SessionHttpResponse,
    state: Option.Option<RequestState>,
  ) {
    if (Option.isSome(state)) {
      return Option.some(state.value.originalByAlias)
    }

    const known = yield* (yield* SessionAliases).get(
      SessionAliases.keyOf(event.sessionID, kindOf(event)),
    )

    /*
     * Unauthorized recovery is skipped for this turn. Tool names still
     * restore from the session's aliases, so without this record the skipped
     * recovery would leave no trace.
     */
    yield* Effect.when(
      pluginLog.debug("request_state_missing", { sessionID: event.sessionID }),
      Effect.succeed(Option.isSome(known)),
    )

    return known
  }),
  /*
   * Rewrite a request to Claude Code's shape with `credential`, and remember
   * how it was sent, for unauthorized recovery and tool-name restoration. A
   * body that cannot be read is a defect, which fails the request.
   */
  mapRequest = Effect.fn("SessionHooks.mapRequest")(function* mapRequest(
    event: RequestEvent,
    credential: RequestState["credential"],
  ) {
    const aliases = yield* SessionAliases,
      key = SessionAliases.keyOf(event.sessionID, kindOf(event)),
      rewriter = yield* RequestTransforms,
      rewritten = yield* rewriter.request(event, credential).pipe(Effect.orDie),
      states = yield* RequestStates

    yield* aliases.merge(key, rewritten.originalByAlias)
    yield* states.remember(
      rewritten.request,
      {
        credential,
        originalByAlias: rewritten.originalByAlias,
        snapshot: rewritten.snapshot,
      },
      event.request,
    )
    event.request = rewritten.request
  }),
  /* Rewrite a request when a Claude Code credential is active. */
  onRequest = (event: RequestEvent): Effect.Effect<void, never, Hooks> =>
    ActiveCredential.pipe(
      Effect.flatMap((active) => active.forRequest),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.void,
          onSome: (credential) => mapRequest(event, credential),
        }),
      ),
    ),
  /*
   * Recover from a 401 and restore the original tool names. A response with
   * neither request state nor session aliases saw no credential of ours.
   */
  onResponse = Effect.fn("SessionHooks.onResponse")(function* onResponse(
    event: SessionHttpResponse,
  ) {
    const state = yield* (yield* RequestStates).lookup(event.request),
      transforms = yield* RequestTransforms,
      used = yield* knownAliases(event, state)

    if (Option.isNone(used)) {
      return
    }

    event.response = yield* transforms.restore(
      yield* answerFor(event.response, state),
      used.value,
    )
  }),
  /*
   * Keep the aliases a context rewrite assigns, or forget the session's
   * when no Claude Code credential is active. Auxiliary model calls need
   * the same subscription identity as the agent loop; their aliases are
   * kept apart because a title can run concurrently.
   */
  rewriteContext = Effect.fn("SessionHooks.rewriteContext")(
    function* rewriteContext(key: string, event: ContextEvent) {
      const active = yield* ActiveCredential,
        aliases = yield* SessionAliases,
        transforms = yield* RequestTransforms

      if (Option.isNone(yield* active.current)) {
        return yield* aliases.forget(key)
      }

      return yield* aliases.replace(key, yield* transforms.context(event))
    },
  ),
  /*
   * Register every session hook, scoped to Anthropic. They do nothing until
   * a credential loads, so they need neither the account list nor each
   * other, and register at once.
   */
  wireHooks = Effect.fn("SessionHooks.register")(function* wireHooks(
    hook: Hook,
  ) {
    const context = yield* Effect.context<Hooks>()

    yield* Effect.forEach(
      CONTEXT_HOOKS,
      ([name, kind]) =>
        hook(
          name,
          (event) =>
            rewriteContext(
              SessionAliases.keyOf(event.sessionID, kind),
              event,
            ).pipe(Effect.provideContext(context)),
          ONLY_ANTHROPIC,
        ),
      { discard: true },
    )
    yield* hook(
      "http.request",
      (event) => onRequest(event).pipe(Effect.provideContext(context)),
      ONLY_ANTHROPIC,
    )
    yield* hook(
      "http.response",
      (event) => onResponse(event).pipe(Effect.provideContext(context)),
      ONLY_ANTHROPIC,
    )
  })

/** The session hooks that apply a Claude Code subscription to model calls. */
export default Object.freeze({
  register: wireHooks,
})
