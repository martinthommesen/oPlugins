import { Context, Effect, HashMap, Layer, Option, Redacted } from "effect"
import { describe, expect, it } from "@effect/vitest"
import AuthUnavailable from "./auth-unavailable-error.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import type { Credential } from "@opencode/plugin/effect"
import { TestClock } from "effect/testing"
import support from "./testing.test-support.ts"

type Sessions = Parameters<typeof support.fakeHost>[typeof SECOND]

const AFTER_EXPIRY_MILLIS = 7_200_000,
  NESTED_CLAIM_TOKEN = support.jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
  }),
  NO_SESSIONS: Sessions = HashMap.empty(),
  SECOND = 1,
  /* The token a host with `credential` connected currently provides. */
  tokenFor = (
    credential: Option.Option<Credential.Key | Credential.OAuth>,
  ): Effect.Effect<
    Effect.Success<ChatGptAuth["Service"]["current"]>,
    Effect.Error<ChatGptAuth["Service"]["current"]>
  > => {
    const host = support.fakeHost(credential, NO_SESSIONS)

    return Layer.build(ChatGptAuth.layer.pipe(Layer.provide(host))).pipe(
      Effect.flatMap((built) => Context.get(built, ChatGptAuth).current),
      Effect.scoped,
    )
  },
  /* The token a ChatGPT sign-in with the access token `access` provides. */
  tokenOfSignIn = (
    access: string,
  ): Effect.Effect<
    Effect.Success<ChatGptAuth["Service"]["current"]>,
    Effect.Error<ChatGptAuth["Service"]["current"]>
  > => tokenFor(Option.some(support.oauthCredential(access)))

describe("current token", () => {
  it.effect("reads the account from the nested token claim", () =>
    Effect.gen(function* nestedClaim() {
      expect.hasAssertions()

      const token = yield* tokenOfSignIn(NESTED_CLAIM_TOKEN)

      expect(token.accountId).toBe("acct-nested")
      expect(Redacted.value(token.accessToken)).toBe(NESTED_CLAIM_TOKEN)
    }),
  )

  it.effect("prefers the account stored in the credential metadata", () =>
    Effect.gen(function* metadataAccount() {
      expect.hasAssertions()

      const credential = Object.assign(
          support.oauthCredential(NESTED_CLAIM_TOKEN),
          { metadata: { accountID: "acct-metadata" } },
        ),
        token = yield* tokenFor(Option.some(credential))

      expect(token.accountId).toBe("acct-metadata")
    }),
  )
})

describe("current token failures", () => {
  it.effect("fails when OpenAI is not connected", () =>
    Effect.gen(function* notConnected() {
      expect.hasAssertions()

      const failure = yield* tokenFor(Option.none()).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )

  it.effect("fails when OpenAI is connected with an API key", () =>
    Effect.gen(function* keyConnected() {
      expect.hasAssertions()

      const apiKey: Credential.Key = { key: "sk-test", type: "key" },
        failure = yield* tokenFor(Option.some(apiKey)).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )
})

describe("current token sign-in failures", () => {
  it.effect("fails when the token names no account", () =>
    Effect.gen(function* noAccount() {
      expect.hasAssertions()

      const failure = yield* tokenOfSignIn(support.jwt({ sub: "user" })).pipe(
        Effect.flip,
      )

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )

  it.effect("fails once the sign-in has expired", () =>
    Effect.gen(function* expired() {
      expect.hasAssertions()

      yield* TestClock.setTime(AFTER_EXPIRY_MILLIS)

      const failure = yield* tokenOfSignIn(NESTED_CLAIM_TOKEN).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(AuthUnavailable)
    }),
  )
})
