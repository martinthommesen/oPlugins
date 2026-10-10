import { Effect, HashMap, Layer, Option, Redacted } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { fakeHost, jwt, oauthCredential } from "./testing.ts"
import { AuthUnavailable } from "./errors/auth-unavailable.ts"
import { ChatGptAuth } from "./chatgpt-auth.ts"
import type { Credential } from "@opencode/plugin/effect"
import type { SessionSnapshot } from "./host.ts"
import { TestClock } from "effect/testing"

const NESTED_CLAIM_TOKEN = jwt({
  "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
})

const AFTER_EXPIRY_MILLIS = 7_200_000

const NO_SESSIONS = HashMap.empty<string, SessionSnapshot>()

const authWith = (
  credential: Option.Option<Credential.Key | Credential.OAuth>,
): Layer.Layer<ChatGptAuth> => {
  const host = fakeHost(credential, NO_SESSIONS)

  return ChatGptAuth.layer.pipe(Layer.provide(host))
}

const signedIn = (access: string): Layer.Layer<ChatGptAuth> =>
  authWith(Option.some(oauthCredential(access)))

const currentToken = Effect.gen(function* currentToken() {
  const auth = yield* ChatGptAuth

  return yield* auth.current
})

describe("current token", () => {
  it.effect("reads the account from the nested token claim", () =>
    Effect.gen(function* nestedClaim() {
      const token = yield* Effect.provide(
        currentToken,
        signedIn(NESTED_CLAIM_TOKEN),
      )

      expect(token.accountId).toBe("acct-nested")
      expect(Redacted.value(token.accessToken)).toBe(NESTED_CLAIM_TOKEN)
    }),
  )

  it.effect("prefers the account stored in the credential metadata", () =>
    Effect.gen(function* metadataAccount() {
      const credential = Object.assign(oauthCredential(NESTED_CLAIM_TOKEN), {
        metadata: { accountID: "acct-metadata" },
      })

      const token = yield* Effect.provide(
        currentToken,
        authWith(Option.some(credential)),
      )

      expect(token.accountId).toBe("acct-metadata")
    }),
  )
})

describe("current token failures", () => {
  it.effect("fails when OpenAI is not connected", () =>
    Effect.gen(function* notConnected() {
      const failure = yield* Effect.provide(
        currentToken,
        authWith(Option.none()),
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )

  it.effect("fails when OpenAI is connected with an API key", () =>
    Effect.gen(function* apiKey() {
      const key: Credential.Key = { key: "sk-test", type: "key" }

      const failure = yield* Effect.provide(
        currentToken,
        authWith(Option.some(key)),
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )

  it.effect("fails when the token names no account", () =>
    Effect.gen(function* noAccount() {
      const failure = yield* Effect.provide(
        currentToken,
        signedIn(jwt({ sub: "user" })),
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )

  it.effect("fails once the sign-in has expired", () =>
    Effect.gen(function* expired() {
      yield* TestClock.setTime(AFTER_EXPIRY_MILLIS)

      const failure = yield* Effect.provide(
        currentToken,
        signedIn(NESTED_CLAIM_TOKEN),
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )
})
