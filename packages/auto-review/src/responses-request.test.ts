import { Effect, Match, Redacted } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { HttpClientRequest } from "effect/unstable/http"
import { buildRequest } from "./responses-request.ts"

const completion = {
  cacheKey: "ses_1",
  input: "Review this.",
  instructions: "Be careful.",
  model: "codex-auto-review",
}

const token = {
  accessToken: Redacted.make("access-token"),
  accountId: "acct-1",
}

const bodyText = (request: HttpClientRequest.HttpClientRequest): string =>
  Match.value(request.body).pipe(
    Match.tag("Uint8Array", (body) => new TextDecoder().decode(body.body)),
    Match.orElse(() => ""),
  )

describe(buildRequest, () => {
  it.effect(
    "authenticates as the ChatGPT account and requests a streaming review",
    () =>
      Effect.gen(function* requestFormat() {
        const request = yield* buildRequest(completion, token, "low")

        expect(request.headers).toMatchObject({
          authorization: "Bearer access-token",
          "chatgpt-account-id": "acct-1",
          originator: "opencode",
        })
        expect(JSON.parse(bodyText(request))).toStrictEqual({
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
