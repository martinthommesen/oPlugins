import { Context, Effect, Layer, Schedule } from "effect"
import {
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

/**
 * Classifies a response before its body is read.
 * @param {string} model The requested model.
 * @param {HttpClientResponse.HttpClientResponse} response The response.
 * @returns {Effect.Effect<HttpClientResponse.HttpClientResponse, CompletionError>}
 * The response when its status is a success.
 */
const checkStatus = Effect.fn("CodexResponses.checkStatus")(
  function* checkStatus(
    model: string,
    response: HttpClientResponse.HttpClientResponse,
  ) {
    const { status } = response

    if (status === HTTP_UNAUTHORIZED || status === HTTP_FORBIDDEN) {
      return yield* new AuthUnavailable({
        reason: `ChatGPT rejected the sign-in (HTTP ${status}). Reconnect OpenAI with /connect.`,
      })
    }

    if (status === HTTP_BAD_REQUEST || status === HTTP_NOT_FOUND) {
      const detail = yield* response.text.pipe(
        requestFailed(model, "readErrorBody"),
      )

      return yield* new ModelUnavailable({ detail, model, status })
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

        const response = yield* client
          .execute(request)
          .pipe(requestFailed(completion.model, "execute"))

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
