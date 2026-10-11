import { Array as Arr, Context, Effect, Layer, Option, Ref } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
} from "effect/unstable/http"
import type { HttpClientRequest } from "effect/unstable/http"

type Responder = (request: HttpClientRequest.HttpClientRequest) => Response

/** What a scripted Codex backend received. */
class FakeBackend extends Context.Service<
  FakeBackend,
  {
    /** Whether the latest request refused to follow redirects. */
    readonly errorRedirects: Ref.Ref<boolean>
    /** The requests it received, oldest first. */
    readonly requests: Ref.Ref<readonly HttpClientRequest.HttpClientRequest[]>
  }
>()("@martinthommesen/oc-auto/fake-backend.test-support/FakeBackend") {
  /* An HTTP client that records each request and answers it with `respond`. */
  public static readonly layer = (
    respond: Responder,
  ): Layer.Layer<FakeBackend | HttpClient.HttpClient> =>
    Layer.effectContext(
      Effect.gen(function* fakeBackend() {
        const errorRedirects = yield* Ref.make(false),
          requests = yield* Ref.make<
            readonly HttpClientRequest.HttpClientRequest[]
          >([]),
          stub = HttpClient.make((request) =>
            Effect.gen(function* execute() {
              const disabled = Option.exists(
                yield* Effect.serviceOption(FetchHttpClient.RequestInit),
                (init: Readonly<Pick<RequestInit, "redirect">>) =>
                  init.redirect === "error",
              )

              yield* Ref.update(requests, Arr.append(request))
              yield* Ref.set(errorRedirects, disabled)

              return HttpClientResponse.fromWeb(request, respond(request))
            }),
          )

        return Context.make(FakeBackend, { errorRedirects, requests }).pipe(
          Context.add(HttpClient.HttpClient, stub),
        )
      }),
    )
}

export default FakeBackend
