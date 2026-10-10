import {
  Array as Arr,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Ref,
  Result,
} from "effect"
import { HttpClient, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "@effect/vitest"
import { AuthUnavailable } from "./errors/auth-unavailable.ts"
import { ChatGptAuth } from "./chatgpt-auth.ts"
import { CodexResponses } from "./codex-client.ts"
import type { HttpClientRequest } from "effect/unstable/http"
import { ModelUnavailable } from "./errors/model-unavailable.ts"
import { RequestFailed } from "./errors/request-failed.ts"
import { settingsFrom } from "./testing.ts"

type Responder = (request: HttpClientRequest.HttpClientRequest) => Response

const HTTP_OK = 200

const HTTP_BAD_REQUEST = 400

const HTTP_UNAUTHORIZED = 401

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

/**
 * Encodes Responses stream events as a server-sent event body.
 * @param {readonly Readonly<Record<string, string>>[]} events The events.
 * @returns {Response} A streaming success response.
 */
const streamOf = (
  events: readonly Readonly<Record<string, string>>[],
): Response =>
  new Response(
    events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
    { headers: { "content-type": "text/event-stream" }, status: HTTP_OK },
  )

const bodyText = (request: HttpClientRequest.HttpClientRequest): string =>
  Match.value(request.body).pipe(
    Match.tag("Uint8Array", (body) => new TextDecoder().decode(body.body)),
    Match.orElse(() => ""),
  )

/**
 * Runs one completion against a fake backend, recording the request.
 * @param {Responder} respond Produces the backend's response.
 * @returns The completion's result and the requests the client sent.
 */
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
          { type: "response.completed" },
        ]),
      )

      expect(outcome).toStrictEqual(Result.succeed('{"outcome":"allow"}'))
      expect(requests).toHaveLength(ONE_REQUEST)
    }),
  )
})

describe("codex responses request", () => {
  it.effect("authenticates as the ChatGPT account and streams", () =>
    Effect.gen(function* requestFormat() {
      const { requests } = yield* completeWith(() => streamOf([]))
      const request = yield* Effect.fromOption(Arr.head(requests))

      expect(request.url).toBe(
        "https://chatgpt.com/backend-api/codex/responses",
      )
      expect(request.headers).toMatchObject({
        authorization: "Bearer access-token",
        "chatgpt-account-id": "acct-1",
        originator: "opencode",
      })
      expect(JSON.parse(bodyText(request))).toMatchObject({
        instructions: "Be careful.",
        model: "codex-auto-review",
        prompt_cache_key: "ses_1",
        store: false,
        stream: true,
      })
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
