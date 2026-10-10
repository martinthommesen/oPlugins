import {
  Array as Arr,
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
import { AuthUnavailable } from "./errors/auth-unavailable.ts"
import { ChatGptAuth } from "./chatgpt-auth.ts"
import { CodexResponses } from "./codex-client.ts"
import type { HttpClientRequest } from "effect/unstable/http"
import { ModelUnavailable } from "./errors/model-unavailable.ts"
import { RequestFailed } from "./errors/request-failed.ts"
import { TestClock } from "effect/testing"
import { settingsFrom } from "./testing.ts"

type Responder = (request: HttpClientRequest.HttpClientRequest) => Response

const HTTP_OK = 200

const HTTP_BAD_REQUEST = 400

const HTTP_UNAUTHORIZED = 401

const HTTP_FORBIDDEN = 403

const HTTP_NOT_FOUND = 404

const HTTP_UNAVAILABLE = 503

const TOTAL_ATTEMPTS = 3

const ONE_REQUEST = 1

const token = {
  accessToken: Redacted.make("access-token"),
  accountId: "acct-1",
}

const signedIn = Layer.succeed(
  ChatGptAuth,
  ChatGptAuth.of({ current: Effect.succeed(token) }),
)

const completion = {
  cacheKey: "ses_1",
  input: "Review this.",
  instructions: "Be careful.",
  model: "codex-auto-review",
}

interface TestEvent {
  readonly delta?: string
  readonly response?: { readonly status: string }
  readonly type: string
}

const streamOf = (events: readonly TestEvent[]): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" }, status: HTTP_OK },
  )

const completeWith = Effect.fn("test.completeWith")(function* completeWith(
  respond: Responder,
) {
  const sent = yield* Ref.make<readonly HttpClientRequest.HttpClientRequest[]>(
    [],
  )

  const http = HttpClient.make((request) => {
    const response = HttpClientResponse.fromWeb(request, respond(request))

    return Ref.update(sent, Arr.append(request)).pipe(Effect.as(response))
  })

  const codex = CodexResponses.layer.pipe(
    Layer.provide([
      signedIn,
      settingsFrom({}),
      Layer.succeed(HttpClient.HttpClient, http),
    ]),
  )

  const outcome = yield* Effect.gen(function* complete() {
    const client = yield* CodexResponses

    return yield* client.complete(completion)
  }).pipe(Effect.provide(codex), Effect.result)

  return { outcome, requests: yield* Ref.get(sent) }
})

describe("codex responses", () => {
  it.effect("streams the reviewer's text from the Codex backend", () =>
    Effect.gen(function* streamsText() {
      const { outcome, requests } = yield* completeWith(() =>
        streamOf([
          { delta: '{"outcome":', type: "response.output_text.delta" },
          { delta: '"allow"}', type: "response.output_text.delta" },
          { response: { status: "completed" }, type: "response.completed" },
        ]),
      )

      const request = yield* Effect.fromOption(Arr.head(requests))

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

  it.effect("does not switch models for an unknown endpoint", () =>
    Effect.gen(function* missingEndpoint() {
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
      const fiber = yield* completeWith(
        () => new Response("Busy", { status: HTTP_UNAVAILABLE }),
      ).pipe(Effect.forkChild)

      yield* TestClock.adjust("1 second")
      const { outcome, requests } = yield* Fiber.join(fiber)

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
      const redirectsDisabled = yield* Ref.make(false)

      const http = HttpClient.make((request) =>
        Effect.gen(function* execute() {
          const options = yield* Effect.serviceOption(
            FetchHttpClient.RequestInit,
          )

          const disabled = Option.exists(
            options,
            (init: Readonly<Pick<RequestInit, "redirect">>) =>
              init.redirect === "error",
          )

          yield* Ref.set(redirectsDisabled, disabled)

          return HttpClientResponse.fromWeb(
            request,
            streamOf([
              {
                delta: '{"outcome":"allow"}',
                type: "response.output_text.delta",
              },
              { response: { status: "completed" }, type: "response.completed" },
            ]),
          )
        }),
      )

      const codex = CodexResponses.layer.pipe(
        Layer.provide([
          signedIn,
          settingsFrom({}),
          Layer.succeed(HttpClient.HttpClient, http),
        ]),
      )

      yield* Effect.gen(function* complete() {
        const client = yield* CodexResponses

        yield* client.complete(completion)
      }).pipe(Effect.provide(codex))

      expect(yield* Ref.get(redirectsDisabled)).toBe(true)
    }),
  )
})
