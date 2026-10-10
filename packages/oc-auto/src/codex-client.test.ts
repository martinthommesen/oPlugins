import {
  Array as Arr,
  Context,
  Effect,
  Fiber,
  Layer,
  Option,
  Redacted,
  Ref,
  Result,
} from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientResponse,
} from "effect/unstable/http"
import { describe, expect, it } from "@effect/vitest"
import AuthUnavailable from "./auth-unavailable-error.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import CodexResponses from "./codex-client.ts"
import type { HttpClientRequest } from "effect/unstable/http"
import ModelUnavailable from "./model-unavailable-error.ts"
import RequestFailed from "./request-failed-error.ts"
import { TestClock } from "effect/testing"
import support from "./testing.test-support.ts"

type Responder = (request: HttpClientRequest.HttpClientRequest) => Response

interface TestEvent {
  readonly delta?: string
  readonly response?: { readonly status: string }
  readonly type: string
}

type Execute = (
  request: HttpClientRequest.HttpClientRequest,
) => Effect.Effect<HttpClientResponse.HttpClientResponse>

const COMPLETION = {
    cacheKey: "ses_1",
    input: "Review this.",
    instructions: "Be careful.",
    model: "codex-auto-review",
  },
  HTTP_BAD_REQUEST = 400,
  HTTP_FORBIDDEN = 403,
  HTTP_NOT_FOUND = 404,
  HTTP_OK = 200,
  HTTP_UNAUTHORIZED = 401,
  HTTP_UNAVAILABLE = 503,
  ONE_REQUEST = 1,
  TOKEN = {
    accessToken: Redacted.make("access-token"),
    accountId: "acct-1",
  },
  TOTAL_ATTEMPTS = 3,
  chatGptSignIn = Layer.succeed(
    ChatGptAuth,
    ChatGptAuth.of({ current: Effect.succeed(TOKEN) }),
  ),
  /* The Codex client over a backend that runs `execute`, signed in, with the default settings. */
  codexWith = (
    execute: Execute,
  ): Layer.Layer<
    CodexResponses,
    Layer.Error<ReturnType<typeof support.settingsFrom>>
  > => {
    const backend = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(execute),
    )

    return CodexResponses.layer.pipe(
      Layer.provide([chatGptSignIn, support.settingsFrom({}), backend]),
    )
  },
  /*
   * Completes one request against a backend that answers with `respond`,
   * and returns the outcome with the requests the backend received.
   */
  completeWith = Effect.fn("test.completeWith")(function* completeWith(
    respond: Responder,
  ) {
    const calls = yield* Ref.make<
        readonly HttpClientRequest.HttpClientRequest[]
      >([]),
      codex = yield* Layer.build(
        codexWith((request) => {
          const response = HttpClientResponse.fromWeb(request, respond(request))

          return Ref.update(calls, Arr.append(request)).pipe(
            Effect.as(response),
          )
        }),
      ),
      outcome = yield* Context.get(codex, CodexResponses)
        .complete(COMPLETION)
        .pipe(Effect.result)

    return { outcome, requests: yield* Ref.get(calls) }
  }, Effect.scoped),
  /* A server-sent event stream of `events`. */
  streamOf = (events: readonly TestEvent[]): Response =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" }, status: HTTP_OK },
    )

describe("codex responses", () => {
  it.effect("streams the reviewer's text from the Codex backend", () =>
    Effect.gen(function* streamsText() {
      expect.hasAssertions()

      const { outcome, requests } = yield* completeWith(() =>
          streamOf([
            { delta: '{"outcome":', type: "response.output_text.delta" },
            { delta: '"allow"}', type: "response.output_text.delta" },
            { response: { status: "completed" }, type: "response.completed" },
          ]),
        ),
        request = yield* Effect.fromOption(Arr.head(requests))

      expect(outcome).toStrictEqual(Result.succeed('{"outcome":"allow"}'))
      expect(requests).toHaveLength(ONE_REQUEST)
      expect(request.url).toBe(
        "https://chatgpt.com/backend-api/codex/responses",
      )
    }),
  )
})

describe("codex responses failures", () => {
  it.effect("reports a rejected model as unavailable", () =>
    Effect.gen(function* rejectedModel() {
      expect.hasAssertions()

      const { outcome } = yield* completeWith(
        () =>
          new Response('{"detail":"Unsupported model"}', {
            status: HTTP_BAD_REQUEST,
          }),
      )

      expect(Option.getOrUndefined(Result.getFailure(outcome))).toBeInstanceOf(
        ModelUnavailable,
      )
    }),
  )

  it.effect("reports a rejected sign-in", () =>
    Effect.gen(function* rejectedSignIn() {
      expect.hasAssertions()

      const { outcome } = yield* completeWith(
        () => new Response("", { status: HTTP_UNAUTHORIZED }),
      )

      expect(Option.getOrUndefined(Result.getFailure(outcome))).toBeInstanceOf(
        AuthUnavailable,
      )
    }),
  )

  it.effect("fails on a failed response event", () =>
    Effect.gen(function* failedEvent() {
      expect.hasAssertions()

      const { outcome } = yield* completeWith(() =>
        streamOf([{ type: "response.failed" }]),
      )

      expect(Option.getOrUndefined(Result.getFailure(outcome))).toBeInstanceOf(
        RequestFailed,
      )
    }),
  )
})

describe("codex request rejection", () => {
  it.effect(
    "does not classify invalid request parameters as model rejection",
    () =>
      Effect.gen(function* invalidParameter() {
        expect.hasAssertions()

        const { outcome } = yield* completeWith(
          () =>
            new Response(
              '{"error":{"code":"context_length_exceeded","message":"The model context window was exceeded."}}',
              { status: HTTP_BAD_REQUEST },
            ),
        )

        expect(
          Option.getOrUndefined(Result.getFailure(outcome)),
        ).toBeInstanceOf(RequestFailed)
      }),
  )
})

describe("codex request rejection by status", () => {
  it.effect("does not switch models for an unknown endpoint", () =>
    Effect.gen(function* missingEndpoint() {
      expect.hasAssertions()

      const { outcome } = yield* completeWith(
        () =>
          new Response('{"detail":"Not Found"}', { status: HTTP_NOT_FOUND }),
      )

      expect(Option.getOrUndefined(Result.getFailure(outcome))).toBeInstanceOf(
        RequestFailed,
      )
    }),
  )

  it.effect("recognizes a structured model-access rejection", () =>
    Effect.gen(function* modelAccess() {
      expect.hasAssertions()

      const { outcome } = yield* completeWith(
        () =>
          new Response(
            '{"error":{"code":"model_not_found","message":"This model is unavailable."}}',
            { status: HTTP_FORBIDDEN },
          ),
      )

      expect(Option.getOrUndefined(Result.getFailure(outcome))).toBeInstanceOf(
        ModelUnavailable,
      )
    }),
  )
})

describe("codex transport policy", () => {
  it.effect("bounds transient retries", () =>
    Effect.gen(function* boundedRetries() {
      expect.hasAssertions()

      const retrying = yield* completeWith(
          () => new Response("Busy", { status: HTTP_UNAVAILABLE }),
        ).pipe(Effect.forkChild),
        { outcome, requests } = yield* TestClock.adjust("1 second").pipe(
          Effect.andThen(Fiber.join(retrying)),
        )

      expect(requests).toHaveLength(TOTAL_ATTEMPTS)
      expect(Option.getOrUndefined(Result.getFailure(outcome))).toBeInstanceOf(
        RequestFailed,
      )
    }),
  )
})

describe("codex authenticated requests", () => {
  it.effect("does not follow redirects with the ChatGPT credential", () =>
    Effect.gen(function* noRedirects() {
      expect.hasAssertions()

      const errorRedirects = yield* Ref.make(false),
        services = yield* Layer.build(
          codexWith((request) =>
            Effect.gen(function* execute() {
              const disabled = Option.exists(
                yield* Effect.serviceOption(FetchHttpClient.RequestInit),
                (init: Readonly<Pick<RequestInit, "redirect">>) =>
                  init.redirect === "error",
              )

              yield* Ref.set(errorRedirects, disabled)

              return HttpClientResponse.fromWeb(
                request,
                streamOf([
                  {
                    delta: '{"outcome":"allow"}',
                    type: "response.output_text.delta",
                  },
                  {
                    response: { status: "completed" },
                    type: "response.completed",
                  },
                ]),
              )
            }),
          ),
        )

      yield* Context.get(services, CodexResponses).complete(COMPLETION)

      expect(yield* Ref.get(errorRedirects)).toBe(true)
    }),
  )
})
