import { Context, Effect, Layer, Option, Ref, Schema } from "effect"
import {
  Headers,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/unstable/http"
import type { HttpClientRequest } from "effect/unstable/http"

/** One request the fake endpoint received. */
interface SentRequest {
  /** The request body as text, or "" when it has none. */
  readonly body: string
  readonly contentType: Option.Option<string>
  readonly method: string
  readonly url: string
}

// A request body held in memory.
const BytesBody = Schema.Struct({ body: Schema.Uint8Array }),
  decoder = new TextDecoder(),
  /*
   * Record the request `incoming` resolves to in `requests`, then answer it
   * with `reply`, or fail as a transport error carrying the reply's failure.
   */
  respond = (
    requests: Ref.Ref<readonly SentRequest[]>,
    reply: Effect.Effect<Response, string>,
    incoming: Effect.Effect<HttpClientRequest.HttpClientRequest>,
  ): Effect.Effect<
    HttpClientResponse.HttpClientResponse,
    HttpClientError.HttpClientError
  > =>
    Effect.gen(function* answerRequest() {
      const request = yield* incoming,
        sent: SentRequest = {
          body: Schema.decodeUnknownOption(BytesBody)(request.body).pipe(
            Option.match({
              onNone: () => "",
              onSome: (bytes) => decoder.decode(bytes.body),
            }),
          ),
          contentType: Headers.get(request.headers, "content-type"),
          method: request.method,
          url: request.url,
        },
        transportFailure = (cause: string): HttpClientError.HttpClientError =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({ cause, request }),
          })

      yield* Ref.update(requests, (sentSoFar) => [...sentSoFar, sent])

      return HttpClientResponse.fromWeb(
        request,
        yield* Effect.mapError(reply, transportFailure),
      )
    })

/**
 * A fake OAuth token endpoint for tests: an `HttpClient` that records every
 * request and answers each with `reply`. A failed `reply` is a network
 * failure carrying that message; one that never completes is an endpoint
 * that never answers.
 */
class TokenEndpoint extends Context.Service<
  TokenEndpoint,
  { readonly requests: Effect.Effect<readonly SentRequest[]> }
>()("oclaude/test/TokenEndpoint") {
  /* Provides `HttpClient` answering with `reply`, and this service to inspect it. */
  public static readonly layer = (
    reply: Effect.Effect<Response, string>,
  ): Layer.Layer<HttpClient.HttpClient | TokenEndpoint> =>
    Layer.effectContext(
      Effect.gen(function* fakeTokenEndpoint() {
        const requests = yield* Ref.make<readonly SentRequest[]>([]),
          stub = HttpClient.makeWith(
            (incoming: Effect.Effect<HttpClientRequest.HttpClientRequest>) =>
              respond(requests, reply, incoming),
            Effect.succeed,
          )

        return Context.make(TokenEndpoint, {
          requests: Ref.get(requests),
        }).pipe(Context.add(HttpClient.HttpClient, stub))
      }),
    )
}

export default TokenEndpoint
