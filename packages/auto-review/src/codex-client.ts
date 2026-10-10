import { Context, Effect, Layer, Option, Schedule, Schema } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"
import AuthUnavailable from "./auth-unavailable-error.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import type HostError from "./host-error.ts"
import ModelUnavailable from "./model-unavailable-error.ts"
import RequestFailed from "./request-failed-error.ts"
import Settings from "./settings.ts"
import responsesRequest from "./responses-request.ts"
import responsesStream from "./responses-stream.ts"

type Completion = Parameters<typeof responsesRequest.build>[typeof FIRST]

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

const ErrorDetail = Schema.Struct({
    code: Schema.optionalKey(Schema.NullOr(Schema.String)),
    message: Schema.optionalKey(Schema.String),
  }),
  ErrorPayload = Schema.Struct({
    detail: Schema.optionalKey(Schema.String),
    error: Schema.optionalKey(ErrorDetail),
  }),
  FIRST = 0,
  HTTP_BAD_REQUEST = 400,
  HTTP_FORBIDDEN = 403,
  HTTP_NOT_FOUND = 404,
  HTTP_UNAUTHORIZED = 401,
  MODEL_ERROR_CODES = new Set([
    "invalid_model",
    "model_not_available",
    "model_not_found",
    "model_not_supported",
    "unsupported_model",
  ]),
  MODEL_REJECTION =
    /\b(?:unsupported|unknown|unavailable|invalid) model\b|\bmodel\b.{0,160}\b(?:not supported|not available|not found|does not exist)\b|\b(?:do not have access|don't have access)\b.{0,80}\bmodel\b/iu,
  RETRY_BASE_DELAY = "250 millis",
  TRANSIENT_RETRIES = 2,
  decodeError = Schema.decodeUnknownOption(Schema.fromJsonString(ErrorPayload)),
  /* Whether an error body says the backend rejected the requested model. */
  modelRejected = (detail: string): boolean =>
    Option.exists(decodeError(detail), (payload) => {
      const apiError = Option.fromUndefinedOr(payload.error),
        code = apiError.pipe(
          Option.flatMap((value) => Option.fromNullishOr(value.code)),
        ),
        message = apiError.pipe(
          Option.flatMap((value) => Option.fromUndefinedOr(value.message)),
        )

      return (
        Option.exists(code, (value) => MODEL_ERROR_CODES.has(value)) ||
        Option.exists(
          Option.orElse(message, () => Option.fromUndefinedOr(payload.detail)),
          (value) => MODEL_REJECTION.test(value),
        )
      )
    }),
  /* The response when its status is a success, or the failure it reports. */
  verifyStatus = Effect.fn("CodexResponses.checkStatus")(function* checkStatus(
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
        RequestFailed.during(model, "readErrorBody"),
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
      RequestFailed.during(model, "status"),
    )
  })

/** Client for the ChatGPT Codex Responses backend. */
class CodexResponses extends Context.Service<CodexResponses, Interface>()(
  "opencode-auto-review/codex-client/CodexResponses",
) {
  public static readonly layer = Layer.effect(
    CodexResponses,
    Effect.gen(function* makeCodexResponses() {
      const auth = yield* ChatGptAuth,
        { baseUrl, reasoningEffort } = yield* Settings,
        client = (yield* HttpClient.HttpClient).pipe(
          HttpClient.mapRequest(HttpClientRequest.prependUrl(baseUrl)),
          HttpClient.retryTransient({
            schedule: Schedule.exponential(RETRY_BASE_DELAY),
            times: TRANSIENT_RETRIES,
          }),
        )

      return CodexResponses.of({
        complete: Effect.fn("CodexResponses.complete")(function* complete(
          completion: Completion,
        ) {
          const credential = yield* auth.current,
            outgoing = yield* responsesRequest.build(
              completion,
              credential,
              reasoningEffort,
            ),
            reply = yield* client.execute(outgoing).pipe(
              Effect.provideService(FetchHttpClient.RequestInit, {
                redirect: "error",
              }),
              RequestFailed.during(completion.model, "execute"),
            ),
            verified = yield* verifyStatus(completion.model, reply)

          return yield* responsesStream.readOutputText(
            completion.model,
            verified,
          )
        }),
      })
    }),
  )
}

export default CodexResponses
