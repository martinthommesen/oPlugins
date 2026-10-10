import { Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import { AuthUnavailable } from "./errors/auth-unavailable.ts"
import { ChatGptAuth } from "./chatgpt-auth.ts"
import type { Completion } from "./responses-request.ts"
import type { HostError } from "./errors/host-error.ts"
import { ModelUnavailable } from "./errors/model-unavailable.ts"
import type { RequestFailed } from "./errors/request-failed.ts"
import { Settings } from "./settings.ts"
import { buildRequest } from "./responses-request.ts"
import { readOutputText } from "./responses-stream.ts"
import { requestFailed } from "./errors/request-failed.ts"

type CompletionError =
  | AuthUnavailable
  | HostError
  | ModelUnavailable
  | RequestFailed

interface Interface {
  /** Sends one request and returns the model's final text. */
  readonly complete: (
    completion: Completion,
  ) => Effect.Effect<string, CompletionError>
}

const HTTP_BAD_REQUEST = 400

const HTTP_UNAUTHORIZED = 401

const HTTP_FORBIDDEN = 403

const HTTP_NOT_FOUND = 404

const TRANSIENT_RETRIES = 2

const RETRY_BASE_DELAY = "250 millis"

const ResponseError = Schema.Struct({
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.String),
})

const ErrorPayload = Schema.Struct({
  detail: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(ResponseError),
})

const decodeError = Schema.decodeUnknownOption(
  Schema.fromJsonString(ErrorPayload),
)

const MODEL_ERROR_CODES = new Set([
  "invalid_model",
  "model_not_available",
  "model_not_found",
  "model_not_supported",
  "unsupported_model",
])

const MODEL_REJECTION =
  /\b(?:unsupported|unknown|unavailable|invalid) model\b|\bmodel\b.{0,160}\b(?:not supported|not available|not found|does not exist)\b|\b(?:do not have access|don't have access)\b.{0,80}\bmodel\b/iu

const modelRejected = (detail: string): boolean =>
  Option.exists(decodeError(detail), (payload) => {
    const error = Option.fromUndefinedOr(payload.error)

    const code = error.pipe(
      Option.flatMap((value) => Option.fromNullishOr(value.code)),
    )

    const message = error.pipe(
      Option.flatMap((value) => Option.fromUndefinedOr(value.message)),
    )

    return (
      Option.exists(code, (value) => MODEL_ERROR_CODES.has(value)) ||
      Option.exists(
        Option.orElse(message, () => Option.fromUndefinedOr(payload.detail)),
        (value) => MODEL_REJECTION.test(value),
      )
    )
  })

const checkStatus = Effect.fn("CodexResponses.checkStatus")(
  function* checkStatus(
    model: string,
    response: HttpClientResponse.HttpClientResponse,
  ) {
    const { status } = response

    if (status === HTTP_UNAUTHORIZED) {
      return yield* new AuthUnavailable({
        reason: `ChatGPT rejected the sign-in (HTTP ${status}). Reconnect OpenAI with /connect.`,
      })
    }

    if (
      status === HTTP_BAD_REQUEST ||
      status === HTTP_FORBIDDEN ||
      status === HTTP_NOT_FOUND
    ) {
      const detail = yield* response.text.pipe(
        requestFailed(model, "readErrorBody"),
      )

      if (modelRejected(detail)) {
        return yield* new ModelUnavailable({ detail, model, status })
      }
    }

    if (status === HTTP_FORBIDDEN) {
      return yield* new AuthUnavailable({
        reason: `ChatGPT rejected the sign-in (HTTP ${status}). Reconnect OpenAI with /connect.`,
      })
    }

    return yield* HttpClientResponse.filterStatusOk(response).pipe(
      requestFailed(model, "status"),
    )
  },
)

/** Client for the ChatGPT Codex Responses backend. */
class CodexResponses extends Context.Service<CodexResponses, Interface>()(
  "opencode-auto-review/CodexResponses",
) {
  public static readonly layer = Layer.effect(
    CodexResponses,
    Effect.gen(function* makeCodexResponses() {
      const auth = yield* ChatGptAuth
      const settings = yield* Settings

      const client = (yield* HttpClient.HttpClient).pipe(
        HttpClient.mapRequest(HttpClientRequest.prependUrl(settings.baseUrl)),
        HttpClient.retryTransient({
          schedule: Schedule.exponential(RETRY_BASE_DELAY),
          times: TRANSIENT_RETRIES,
        }),
      )

      const complete = Effect.fn("CodexResponses.complete")(function* complete(
        completion: Completion,
      ) {
        const token = yield* auth.current

        const request = yield* buildRequest(
          completion,
          token,
          settings.reasoningEffort,
        )

        const response = yield* client.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, {
            redirect: "error",
          }),
          requestFailed(completion.model, "execute"),
        )

        const ok = yield* checkStatus(completion.model, response)

        return yield* readOutputText(completion.model, ok)
      })

      return CodexResponses.of({ complete })
    }),
  )
}

export { CodexResponses }

export type { Completion } from "./responses-request.ts"

export type { CompletionError }
