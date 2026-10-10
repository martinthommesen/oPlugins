import { Effect, Option } from "effect"
import ActiveCredential from "./active-credential.ts"
import DebugLog from "./debug-log.ts"
import type { Plugin } from "@opencode/plugin/effect"
import RequestStates from "./request-states.ts"
import RequestTransforms from "./request-transforms.ts"
import SessionAliases from "./session-aliases.ts"
import type { SessionHttpResponse } from "@opencode/plugin/effect/session"
import claudeCodeCredential from "./claude-code-credential.ts"
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
  | DebugLog
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
   * Rewrite a request to Claude Code's shape with `credential`, and remember
   * how it was sent, for 401 recovery and tool-name restoration. A body that
   * cannot be read fails the request, as a rejected hook did.
   */
  mapRequest = (
    event: RequestEvent,
    credential: RequestState["credential"],
  ): Effect.Effect<void, never, Hooks> =>
    Effect.gen(function* rewriteRequest() {
      const aliases = yield* SessionAliases,
        key = SessionAliases.keyOf(event.sessionID, kindOf(event)),
        rewriter = yield* RequestTransforms,
        rewritten = yield* rewriter
          .request(event, credential)
          .pipe(Effect.orDie),
        states = yield* RequestStates

      yield* aliases.merge(key, rewritten.originalByAlias)
      yield* states.remember(rewritten.request, {
        credential,
        snapshot: rewritten.snapshot,
      })
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
  onResponse = (
    event: SessionHttpResponse,
  ): Effect.Effect<void, never, Hooks> =>
    Effect.gen(function* responseHook() {
      const aliases = yield* SessionAliases,
        debugLog = yield* DebugLog,
        known = yield* aliases.get(
          SessionAliases.keyOf(event.sessionID, kindOf(event)),
        ),
        state = yield* (yield* RequestStates).lookup(event.request),
        transforms = yield* RequestTransforms

      if (Option.isNone(state) && Option.isNone(known)) {
        return
      }

      if (Option.isNone(state)) {
        /*
         * The host handed back a Request other than the one the request hook
         * produced, so 401 recovery is skipped for this turn. Tool names
         * still restore from the session's aliases, which makes the
         * degradation invisible without this.
         */
        yield* debugLog.log("request_state_missing", {
          sessionID: event.sessionID,
        })
      }

      event.response = yield* transforms.restore(
        yield* answerFor(event.response, state),
        Option.getOrElse(known, () => ({})),
      )
    }),
  /*
   * Keep the aliases a context rewrite assigns, or forget the session's
   * when no Claude Code credential is active. Auxiliary model calls need
   * the same subscription identity as the agent loop; their aliases are
   * kept apart because a title can run concurrently.
   */
  rewriteContext = (
    key: string,
    event: ContextEvent,
  ): Effect.Effect<void, never, Hooks> =>
    Effect.gen(function* contextHook() {
      const active = yield* ActiveCredential,
        aliases = yield* SessionAliases,
        transforms = yield* RequestTransforms

      if (Option.isNone(yield* active.current)) {
        return yield* aliases.forget(key)
      }

      return yield* aliases.replace(key, yield* transforms.context(event))
    }),
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
