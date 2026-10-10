import type ChatGptAuth from "./chatgpt-auth.ts"
import type { Effect } from "effect"
import { HttpClientRequest } from "effect/unstable/http"
import RequestFailed from "./request-failed-error.ts"
import { Schema } from "effect"
import Settings from "./settings.ts"

interface Completion {
  /** Groups one session's reviews for the backend's prompt cache. */
  readonly cacheKey: string
  readonly input: string
  readonly instructions: string
  readonly model: string
}

const ContentText = Schema.Struct({
    text: Schema.String,
    type: Schema.Literal("input_text"),
  }),
  InputMessage = Schema.Struct({
    content: Schema.Array(ContentText),
    role: Schema.Literal("user"),
    type: Schema.Literal("message"),
  }),
  /** Codex sends this beta header with every Responses request. */
  RESPONSES_BETA = "responses=experimental",
  ResponsesRequest = Schema.Struct({
    input: Schema.Array(InputMessage),
    instructions: Schema.String,
    model: Schema.String,
    prompt_cache_key: Schema.String,
    reasoning: Schema.Struct({
      effort: Schema.Literals(Settings.reasoningEfforts),
    }),
    store: Schema.Literal(false),
    stream: Schema.Literal(true),
  }),
  /* The streaming Responses request for `completion`, signed with `token`. */
  buildRequest = (
    completion: Completion,
    token: Effect.Success<ChatGptAuth["Service"]["current"]>,
    effort: Settings["Service"]["reasoningEffort"],
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
      RequestFailed.during(completion.model, "encodeBody"),
    )

/** Builds the requests sent to the Codex Responses backend. */
export default Object.freeze({ build: buildRequest })
