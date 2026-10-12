import { Context, Effect, Layer } from "effect"
import AnthropicFetchError from "./anthropic-fetch-error.ts"
import { FetchHttpClient } from "effect/http"

/*
 * Send `request` with the runtime's `fetch`. The host hands the plugin Fetch
 * API objects and expects them back, so a replay stays one: its response
 * body streams through untouched, and the host can cancel it. The request's
 * own signal, the turn's, aborts it and its body, and so does interrupting
 * the send before the response arrives.
 */
const send = Effect.fn("AnthropicFetch.send")(function* send(request: Request) {
  const fetchFn = yield* FetchHttpClient.Fetch

  return yield* Effect.tryPromise({
    catch: (cause) =>
      AnthropicFetchError.make({
        cause,
        message: "the replayed request failed",
      }),
    try: (signal): PromiseLike<Response> =>
      fetchFn(request, { signal: AbortSignal.any([request.signal, signal]) }),
  })
})

/** Sends the requests unauthorized recovery replays to the Anthropic API. */
class AnthropicFetch extends Context.Service<
  AnthropicFetch,
  {
    readonly send: (
      request: Request,
    ) => Effect.Effect<Response, AnthropicFetchError>
  }
>()("@martinthommesen/oc-auth/anthropic-fetch/AnthropicFetch") {
  /** Replays through the runtime's `fetch`. */
  public static readonly layer: Layer.Layer<AnthropicFetch> = Layer.succeed(
    AnthropicFetch,
    AnthropicFetch.of({ send }),
  )
}

export default AnthropicFetch
