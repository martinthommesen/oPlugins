import type { ChatGptToken } from "./chatgpt-auth.ts"
import type { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import { ReasoningEffort } from "./settings.ts"
import type { RequestFailed } from "./errors/request-failed.ts"
import { Schema } from "effect"
import { requestFailed } from "./errors/request-failed.ts"

interface Completion {
  /** Groups one session's reviews for the backend's prompt cache. */
  readonly cacheKey: string
  readonly input: string
  readonly instructions: string
  readonly model: string
}

const InputText = Schema.Struct({
  text: Schema.String,
  type: Schema.Literal("input_text"),
})

const InputMessage = Schema.Struct({
  content: Schema.Array(InputText),
  role: Schema.Literal("user"),
  type: Schema.Literal("message"),
})

const ResponsesRequest = Schema.Struct({
  input: Schema.Array(InputMessage),
  instructions: Schema.String,
  model: Schema.String,
  prompt_cache_key: Schema.String,
  reasoning: Schema.Struct({ effort: Schema.Literals(ReasoningEffort) }),
  store: Schema.Literal(false),
  stream: Schema.Literal(true),
})

/** Codex sends this beta header with every Responses request. */
const RESPONSES_BETA = "responses=experimental"

/**
 * Builds the streaming Responses request for one completion.
 * @param {Completion} completion What to send.
 * @param {ChatGptToken} token The credential to send it with.
 * @param {ReasoningEffort} effort The reasoning effort to request.
 * @returns {Effect.Effect<HttpClientRequest.HttpClientRequest, RequestFailed>}
 * The request.
 */
const buildRequest = (
  completion: Completion,
  token: ChatGptToken,
  effort: ReasoningEffort,
): Effect.Effect<HttpClientRequest.HttpClientRequest, RequestFailed> =>
  HttpClientRequest.post("/responses").pipe(
    HttpClientRequest.bearerToken(token.accessToken),
    HttpClientRequest.setHeaders({
      accept: "text/event-stream",
      "chatgpt-account-id": token.accountId,
      "openai-beta": RESPONSES_BETA,
      originator: "opencode",
      session_id: completion.cacheKey,
    }),
    HttpClientRequest.schemaBodyJson(ResponsesRequest)({
      input: [
        {
          content: [{ text: completion.input, type: "input_text" }],
          role: "user",
          type: "message",
        },
      ],
      instructions: completion.instructions,
      model: completion.model,
      prompt_cache_key: completion.cacheKey,
      reasoning: { effort },
      store: false,
      stream: true,
    }),
    requestFailed(completion.model, "encodeBody"),
  )

export { buildRequest }

export type { Completion }
