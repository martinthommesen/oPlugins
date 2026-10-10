import { Crypto, Effect, Option, Stream } from "effect"
import type { Credential } from "@opencode/plugin/effect"
import DebugLog from "./debug-log.ts"
import Environment from "./environment.ts"
import RequestBodyError from "./request-body-error.ts"
import type { SessionHttpRequest } from "@opencode/plugin/effect/session"
import claudeHeaders from "./claude-headers.ts"
import requestBodyAliases from "./request-body-aliases.ts"
import requestSnapshot from "./request-snapshot.ts"

/** Maps each alias this plugin applied back to the OpenCode tool name. */
type OriginalByAlias = Readonly<Record<string, string>>

type RequestSnapshot = ReturnType<typeof requestSnapshot.capture>

type AliasedBody = Option.Option.Value<
  ReturnType<typeof requestBodyAliases.alias>
>

/** The part of a credential a request is sent with. */
type AccessCredential = Pick<Credential.OAuth, "access">

/** An outbound request rewritten for subscription billing. */
interface TransformedRequest {
  /** The tool-name aliases the request was sent with. */
  readonly originalByAlias: OriginalByAlias
  /** The request to send in place of the host's. */
  readonly request: Request
  /** What a 401 replay rebuilds the request from. */
  readonly snapshot: RequestSnapshot
}

const NO_ALIASES: OriginalByAlias = Object.freeze({}),
  /*
   * `body` with its tool names aliased. A body that is not the expected JSON
   * is sent un-aliased, which the billing validator may reject over tool
   * names.
   */
  aliasBody = Effect.fn("RequestTransforms.aliasBody")(function* aliasBody(
    body: Uint8Array<ArrayBuffer>,
  ) {
    const debugLog = yield* DebugLog

    return yield* Option.match(requestBodyAliases.alias(body), {
      onNone: () =>
        debugLog.log("request_body_not_json", { bytes: body.byteLength }).pipe(
          Effect.as<AliasedBody>({
            body,
            model: Option.none(),
            originalByAlias: NO_ALIASES,
          }),
        ),
      onSome: (aliased) => Effect.succeed(aliased),
    })
  }),
  /* The request's body, buffered, or none when it has none. */
  readBody = (
    request: Request,
  ): Effect.Effect<Option.Option<Uint8Array<ArrayBuffer>>, RequestBodyError> =>
    Option.match(Option.fromNullishOr(request.clone().body), {
      onNone: () => Effect.succeedNone,
      onSome: (body) =>
        Stream.fromReadableStream({
          evaluate: () => body,
          onError: (cause) =>
            RequestBodyError.make({
              cause,
              message: "The request body could not be read.",
            }),
        }).pipe(
          Stream.mkUint8Array,
          // A copy, because a request body must own its `ArrayBuffer`.
          Effect.map((bytes) => Option.some(new Uint8Array(bytes))),
        ),
    }),
  /* A request from `snapshot`, sent with `credential` as Claude Code sends it. */
  replayRequest = Effect.fn("RequestTransforms.replay")(function* replay(
    snapshot: RequestSnapshot,
    credential: AccessCredential,
    sessionID: string,
  ) {
    const crypto = yield* Crypto.Crypto,
      environment = yield* Environment,
      requestID = yield* crypto.randomUUIDv4.pipe(Effect.orDie)

    return requestSnapshot.rebuild(
      snapshot,
      claudeHeaders.build(
        {
          accessToken: credential.access,
          modelID: snapshot.modelID,
          original: snapshot.headers,
          requestID,
          sessionID,
        },
        environment.variables,
        environment.process,
      ),
    )
  }),
  /*
   * The host's request rewritten for subscription billing: Claude Code's
   * headers and URL, and the body's tool names aliased. The snapshot keeps
   * the rewritten body for replays.
   */
  transformRequest = Effect.fn("RequestTransforms.request")(function* request(
    event: SessionHttpRequest,
    credential: AccessCredential,
    sessionID: string,
  ) {
    const buffered = yield* readBody(event.request),
      rewritten = yield* Effect.transposeOption(
        buffered.pipe(Option.map((body) => aliasBody(body))),
      ),
      snapshot = requestSnapshot.capture(
        event.request,
        rewritten.pipe(Option.map((aliased) => aliased.body)),
        // A body that names no model keeps the host's model ID.
        rewritten.pipe(
          Option.flatMap((aliased) => aliased.model),
          Option.getOrElse(() => event.model.id),
        ),
      ),
      wire = yield* replayRequest(snapshot, credential, sessionID)

    return {
      originalByAlias: Option.match(rewritten, {
        onNone: () => NO_ALIASES,
        onSome: (aliased) => aliased.originalByAlias,
      }),
      request: wire,
      snapshot,
    } satisfies TransformedRequest
  })

/** Outbound requests rewritten for subscription billing, and their replays. */
export default Object.freeze({
  replay: replayRequest,
  transform: transformRequest,
})
