import { Array as Arr, Context, Effect, Layer, Option, Ref } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientResponse,
} from "effect/http"
import type { HttpClientRequest } from "effect/http"

/** How the fake service answers one request. */
type Responder = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<Response, HttpClientError.HttpClientError>

/** What a scripted usage service received. */
class FakeService extends Context.Service<
  FakeService,
  {
    /** How each request said to treat a redirect, oldest first. */
    readonly redirects: Ref.Ref<readonly string[]>
    /** The requests it received, oldest first. */
    readonly requests: Ref.Ref<readonly HttpClientRequest.HttpClientRequest[]>
  }
>()("@martinthommesen/oc-usage/fake-service.test-support/FakeService") {
  /* An HTTP client that records each request and answers it with `respond`. */
  public static readonly layer = (
    respond: Responder,
  ): Layer.Layer<FakeService | HttpClient.HttpClient> =>
    Layer.effectContext(
      Effect.gen(function* fakeService() {
        const redirects = yield* Ref.make<readonly string[]>([]),
          requests = yield* Ref.make<
            readonly HttpClientRequest.HttpClientRequest[]
          >([]),
          stub = HttpClient.make((request) =>
            Effect.gen(function* execute() {
              const init = yield* Effect.serviceOption(
                  FetchHttpClient.RequestInit,
                ),
                redirect = init.pipe(
                  Option.flatMap(
                    (options: Readonly<Pick<RequestInit, "redirect">>) =>
                      Option.fromUndefinedOr(options.redirect),
                  ),
                  Option.getOrElse(() => "follow"),
                )

              yield* Ref.update(requests, Arr.append(request))
              yield* Ref.update(redirects, Arr.append(redirect))

              return HttpClientResponse.fromWeb(
                request,
                yield* respond(request),
              )
            }),
          )

        return Context.make(FakeService, { redirects, requests }).pipe(
          Context.add(HttpClient.HttpClient, stub),
        )
      }),
    )

  /* A responder whose network is down. */
  public static readonly unreachable: Responder = (request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request }),
      }),
    )
}

/** @internal */
export default FakeService
