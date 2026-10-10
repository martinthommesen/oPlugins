import { Effect, Match, Redacted, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { HttpClientRequest } from "effect/unstable/http"
import responsesRequest from "./responses-request.ts"

const COMPLETION = {
    cacheKey: "ses_1",
    input: "Review this.",
    instructions: "Be careful.",
    model: "codex-auto-review",
  },
  TOKEN = {
    accessToken: Redacted.make("access-token"),
    accountId: "acct-1",
  },
  /* The request's body, as text. */
  bodyText = (request: HttpClientRequest.HttpClientRequest): string =>
    Match.value(request.body).pipe(
      Match.tag("Uint8Array", (body: { readonly body: Uint8Array }) =>
        new TextDecoder().decode(body.body),
      ),
      Match.orElse(() => ""),
    ),
  decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

describe("buildRequest", () => {
  it.effect(
    "authenticates as the ChatGPT account and requests a streaming review",
    () =>
      Effect.gen(function* requestFormat() {
        expect.hasAssertions()

        const request = yield* responsesRequest.build(COMPLETION, TOKEN, "low"),
          sentBody = bodyText(request)

        expect(request.headers).toMatchObject({
          authorization: "Bearer access-token",
          "chatgpt-account-id": "acct-1",
          originator: "opencode",
        })
        expect(yield* decodeJson(sentBody)).toStrictEqual({
          input: [
            {
              content: [{ text: "Review this.", type: "input_text" }],
              role: "user",
              type: "message",
            },
          ],
          instructions: "Be careful.",
          model: "codex-auto-review",
          prompt_cache_key: "ses_1",
          reasoning: { effort: "low" },
          store: false,
          stream: true,
        })
      }),
  )
})
