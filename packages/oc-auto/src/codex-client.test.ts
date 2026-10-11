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
import { describe, expect, it as test } from "@effect/vitest"
import AuthUnavailable from "./auth-unavailable-error.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import CodexResponses from "./codex-client.ts"
import FakeBackend from "./fake-backend.test-support.ts"
import ModelUnavailable from "./model-unavailable-error.ts"
import RequestFailed from "./request-failed-error.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import support from "./testing.test-support.ts"

type Responder = Parameters<typeof FakeBackend.layer>[typeof FIRST]

interface TestEvent {
  readonly delta?: string
  readonly response?: { readonly status: string }
  readonly type: string
}

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<CodexResponses | FakeBackend | Scope.Scope>
}

const COMPLETION = {
    cacheKey: "ses_1",
    input: "Review this.",
    instructions: "Be careful.",
    model: "codex-auto-review",
  },
  FIRST = 0,
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
  /* The Codex client over a backend that answers with `respond`, signed in, with the default settings. */
  codexWith = (
    respond: Responder,
  ): Layer.Layer<
    CodexResponses | FakeBackend,
    Layer.Error<ReturnType<typeof support.settingsFrom>>
  > =>
    CodexResponses.layer.pipe(
      Layer.provide([chatGptSignIn, support.settingsFrom({})]),
      Layer.provideMerge(FakeBackend.layer(respond)),
    ),
  /**
   * One request completed with the block's client: its outcome, and the
   * requests the backend received.
   */
  completion = Effect.gen(function* completion() {
    const backend = yield* FakeBackend,
      outcome = yield* (yield* CodexResponses)
        .complete(COMPLETION)
        .pipe(Effect.result)

    return { outcome, requests: yield* Ref.get(backend.requests) }
  }),
  /* A server-sent event stream of `events`. */
  streamOf = (events: readonly TestEvent[]): Response =>
    new Response(
      events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
      { headers: { "content-type": "text/event-stream" }, status: HTTP_OK },
    ),
  /* The backend refusing the sign-in. */
  unauthorized: Responder = () =>
    new Response("", { status: HTTP_UNAUTHORIZED }),
  /* The backend refusing the model. */
  unsupportedModel: Responder = () =>
    new Response('{"detail":"Unsupported model"}', {
      status: HTTP_BAD_REQUEST,
    })

describe("codex responses", () => {
  test.layer(
    codexWith(() =>
      streamOf([
        { delta: '{"outcome":', type: "response.output_text.delta" },
        { delta: '"allow"}', type: "response.output_text.delta" },
        { response: { status: "completed" }, type: "response.completed" },
      ]),
    ),
  )((it: Tests) => {
    it.effect("streams the reviewer's text from the Codex backend", () =>
      Effect.gen(function* streamsText() {
        expect.hasAssertions()

        const { outcome, requests } = yield* completion,
          request = yield* Effect.fromOption(Arr.head(requests))

        expect(outcome).toStrictEqual(Result.succeed('{"outcome":"allow"}'))
        expect(requests).toHaveLength(ONE_REQUEST)
        expect(request.url).toBe(
          "https://chatgpt.com/backend-api/codex/responses",
        )
      }),
    )
  })
})

describe("codex responses failures", () => {
  test.layer(codexWith(unsupportedModel))((it: Tests) => {
    it.effect("reports a rejected model as unavailable", () =>
      Effect.gen(function* rejectedModel() {
        expect.hasAssertions()

        const { outcome } = yield* completion

        expect(
          Option.getOrUndefined(Result.getFailure(outcome)),
        ).toBeInstanceOf(ModelUnavailable)
      }),
    )
  })

  test.layer(codexWith(unauthorized))((it: Tests) => {
    it.effect("reports a rejected sign-in", () =>
      Effect.gen(function* rejectedSignIn() {
        expect.hasAssertions()

        const { outcome } = yield* completion

        expect(
          Option.getOrUndefined(Result.getFailure(outcome)),
        ).toBeInstanceOf(AuthUnavailable)
      }),
    )
  })

  test.layer(codexWith(() => streamOf([{ type: "response.failed" }])))(
    (it: Tests) => {
      it.effect("fails on a failed response event", () =>
        Effect.gen(function* failedEvent() {
          expect.hasAssertions()

          const { outcome } = yield* completion

          expect(
            Option.getOrUndefined(Result.getFailure(outcome)),
          ).toBeInstanceOf(RequestFailed)
        }),
      )
    },
  )
})

describe("codex request rejection", () => {
  test.layer(
    codexWith(
      () =>
        new Response(
          '{"error":{"code":"context_length_exceeded","message":"The model context window was exceeded."}}',
          { status: HTTP_BAD_REQUEST },
        ),
    ),
  )((it: Tests) => {
    it.effect(
      "does not classify invalid request parameters as model rejection",
      () =>
        Effect.gen(function* invalidParameter() {
          expect.hasAssertions()

          const { outcome } = yield* completion

          expect(
            Option.getOrUndefined(Result.getFailure(outcome)),
          ).toBeInstanceOf(RequestFailed)
        }),
    )
  })
})

describe("codex request rejection by status", () => {
  test.layer(
    codexWith(
      () => new Response('{"detail":"Not Found"}', { status: HTTP_NOT_FOUND }),
    ),
  )((it: Tests) => {
    it.effect("does not switch models for an unknown endpoint", () =>
      Effect.gen(function* missingEndpoint() {
        expect.hasAssertions()

        const { outcome } = yield* completion

        expect(
          Option.getOrUndefined(Result.getFailure(outcome)),
        ).toBeInstanceOf(RequestFailed)
      }),
    )
  })

  test.layer(
    codexWith(
      () =>
        new Response(
          '{"error":{"code":"model_not_found","message":"This model is unavailable."}}',
          { status: HTTP_FORBIDDEN },
        ),
    ),
  )((it: Tests) => {
    it.effect("recognizes a structured model-access rejection", () =>
      Effect.gen(function* modelAccess() {
        expect.hasAssertions()

        const { outcome } = yield* completion

        expect(
          Option.getOrUndefined(Result.getFailure(outcome)),
        ).toBeInstanceOf(ModelUnavailable)
      }),
    )
  })
})

describe("codex transport policy", () => {
  test.layer(
    codexWith(() => new Response("Busy", { status: HTTP_UNAVAILABLE })),
  )((it: Tests) => {
    it.effect("bounds transient retries", () =>
      Effect.gen(function* boundedRetries() {
        expect.hasAssertions()

        const retrying = yield* completion.pipe(Effect.forkChild),
          { outcome, requests } = yield* TestClock.adjust("1 second").pipe(
            Effect.andThen(Fiber.join(retrying)),
          )

        expect(requests).toHaveLength(TOTAL_ATTEMPTS)
        expect(
          Option.getOrUndefined(Result.getFailure(outcome)),
        ).toBeInstanceOf(RequestFailed)
      }),
    )
  })
})

describe("codex authenticated requests", () => {
  test.layer(
    codexWith(() =>
      streamOf([
        { delta: '{"outcome":"allow"}', type: "response.output_text.delta" },
        { response: { status: "completed" }, type: "response.completed" },
      ]),
    ),
  )((it: Tests) => {
    it.effect("does not follow redirects with the ChatGPT credential", () =>
      Effect.gen(function* noRedirects() {
        expect.hasAssertions()

        const { errorRedirects } = yield* FakeBackend

        yield* (yield* CodexResponses).complete(COMPLETION)

        expect(yield* Ref.get(errorRedirects)).toBe(true)
      }),
    )
  })
})
