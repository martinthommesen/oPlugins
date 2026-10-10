import { Context, Crypto, Effect, Layer } from "effect"
import type {
  SessionContext,
  SessionHttpRequest,
  SessionTitle,
} from "@opencode/plugin/effect/session"
import type { Credential } from "@opencode/plugin/effect"
import type DebugLog from "./debug-log.ts"
import type Environment from "./environment.ts"
import type RequestBodyError from "./request-body-error.ts"
import outboundRequest from "./outbound-request.ts"
import responseRestoration from "./response-restoration.ts"
import sessionContext from "./session-context.ts"

/** Maps each alias this plugin applied back to the OpenCode tool name. */
type OriginalByAlias = Readonly<Record<string, string>>

type TransformedRequest = Effect.Success<
  ReturnType<typeof outboundRequest.transform>
>

type RequestSnapshot = TransformedRequest["snapshot"]

/** The part of a credential a request is sent with. */
type AccessCredential = Pick<Credential.OAuth, "access">

/**
 * The request and response rewrites that let OpenCode traffic bill to a
 * Claude subscription: the session context, outbound requests and their 401
 * replays, and tool names in responses.
 */
class RequestTransforms extends Context.Service<
  RequestTransforms,
  {
    /**
     * Rewrite a `context`, `compaction`, `generate` or `title` event in
     * place. Returns the aliases the registered tools will carry on the wire.
     */
    readonly context: (
      event: SessionContext | SessionTitle,
    ) => Effect.Effect<OriginalByAlias>
    /** The request a snapshot describes, sent again with a credential. */
    readonly replay: (
      snapshot: RequestSnapshot,
      credential: AccessCredential,
    ) => Effect.Effect<Request>
    /** The `http.request` event's request, rewritten to send with a credential. */
    readonly request: (
      event: SessionHttpRequest,
      credential: AccessCredential,
    ) => Effect.Effect<TransformedRequest, RequestBodyError>
    /** A response with the original tool names restored. */
    readonly restore: (
      response: Response,
      originalByAlias: OriginalByAlias,
    ) => Effect.Effect<Response>
  }
>()("@martinthommesen/oc-auth/request-transforms/RequestTransforms") {
  /** The live transforms, with one Claude Code session id for their lifetime. */
  public static readonly layer: Layer.Layer<
    RequestTransforms,
    never,
    Crypto.Crypto | DebugLog | Environment
  > = Layer.effect(
    RequestTransforms,
    Effect.gen(function* makeRequestTransforms() {
      const context = yield* Effect.context<
          Crypto.Crypto | DebugLog | Environment
        >(),
        crypto = yield* Crypto.Crypto,
        // UUIDs cannot fail on a working platform.
        sessionID = yield* crypto.randomUUIDv4.pipe(Effect.orDie)

      return RequestTransforms.of({
        context: (event) =>
          sessionContext.rewrite(event).pipe(Effect.provideContext(context)),
        replay: (snapshot, credential) =>
          outboundRequest
            .replay(snapshot, credential, sessionID)
            .pipe(Effect.provideContext(context)),
        request: (event, credential) =>
          outboundRequest
            .transform(event, credential, sessionID)
            .pipe(Effect.provideContext(context)),
        restore: (response, originalByAlias) =>
          responseRestoration.restore(response, originalByAlias),
      })
    }),
  )
}

export default RequestTransforms
