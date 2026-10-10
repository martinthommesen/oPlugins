import { Context, Effect, Layer } from "effect"
import AnthropicFetchError from "./anthropic-fetch-error.ts"
import { FetchHttpClient } from "effect/unstable/http"

/*
 * Send `request` with the runtime's `fetch`. The host hands this plugin and
 * expects back Fetch API objects, so a replay stays one: the response body
 * streams through untouched, and the host can cancel it.
 */
const send = Effect.fn("AnthropicFetch.send")(function* send(request: Request) {
  const fetchFn = yield* FetchHttpClient.Fetch

  return yield* Effect.tryPromise({
    catch: (cause) =>
      new AnthropicFetchError({
        cause,
        message: "the replayed request failed",
      }),
    try: (signal): PromiseLike<Response> => fetchFn(request, { signal }),
  })
})

/** Replays requests to the Anthropic API after a 401 was recovered from. */
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
