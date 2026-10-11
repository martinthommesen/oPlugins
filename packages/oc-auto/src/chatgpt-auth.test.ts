import { Effect, HashMap, Layer, Option, Redacted } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import AuthUnavailable from "./auth-unavailable-error.ts"
import ChatGptAuth from "./chatgpt-auth.ts"
import type { Credential } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import support from "./testing.test-support.ts"

type Sessions = Parameters<typeof support.fakeHost>[typeof SECOND]

/** The `it` of a `test.layer` block: `it.effect`, given the ChatGPT auth. */
interface Tests {
  readonly effect: Vitest.Test<ChatGptAuth | Scope.Scope>
}

const AFTER_EXPIRY_MILLIS = 7_200_000,
  NESTED_CLAIM_TOKEN = support.jwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct-nested" },
  }),
  NO_SESSIONS: Sessions = HashMap.empty(),
  SECOND = 1,
  /* The ChatGPT auth of a host with `credential` connected. */
  authFor = (
    credential: Option.Option<Credential.Key | Credential.OAuth>,
  ): Layer.Layer<ChatGptAuth> =>
    ChatGptAuth.layer.pipe(
      Layer.provide(support.fakeHost(credential, NO_SESSIONS)),
    ),
  /** A ChatGPT sign-in that also names its account in the credential metadata. */
  credentialWithMetadata = Object.assign(
    support.oauthCredential(NESTED_CLAIM_TOKEN),
    { metadata: { accountID: "acct-metadata" } },
  ),
  /** The token the block's host currently provides. */
  currentToken = ChatGptAuth.pipe(Effect.flatMap((auth) => auth.current)),
  /* The ChatGPT auth of a sign-in with the access token `access`. */
  signedIn = (access: string): Layer.Layer<ChatGptAuth> =>
    authFor(Option.some(support.oauthCredential(access)))

describe("current token", () => {
  test.layer(signedIn(NESTED_CLAIM_TOKEN))((it: Tests) => {
    it.effect("reads the account from the nested token claim", () =>
      Effect.gen(function* nestedClaim() {
        expect.hasAssertions()

        const token = yield* currentToken

        expect(token.accountId).toBe("acct-nested")
        expect(Redacted.value(token.accessToken)).toBe(NESTED_CLAIM_TOKEN)
      }),
    )
  })

  test.layer(authFor(Option.some(credentialWithMetadata)))((it: Tests) => {
    it.effect("prefers the account stored in the credential metadata", () =>
      Effect.gen(function* metadataAccount() {
        expect.hasAssertions()

        const token = yield* currentToken

        expect(token.accountId).toBe("acct-metadata")
      }),
    )
  })
})

describe("current token failures", () => {
  test.layer(authFor(Option.none()))((it: Tests) => {
    it.effect("fails when OpenAI is not connected", () =>
      Effect.gen(function* notConnected() {
        expect.hasAssertions()

        const failure = yield* currentToken.pipe(Effect.flip)

        expect(failure).toBeInstanceOf(AuthUnavailable)
      }),
    )
  })

  test.layer(authFor(Option.some({ key: "sk-test", type: "key" })))(
    (it: Tests) => {
      it.effect("fails when OpenAI is connected with an API key", () =>
        Effect.gen(function* keyConnected() {
          expect.hasAssertions()

          const failure = yield* currentToken.pipe(Effect.flip)

          expect(failure).toBeInstanceOf(AuthUnavailable)
        }),
      )
    },
  )
})

describe("current token sign-in failures", () => {
  test.layer(signedIn(support.jwt({ sub: "user" })))((it: Tests) => {
    it.effect("fails when the token names no account", () =>
      Effect.gen(function* noAccount() {
        expect.hasAssertions()

        const failure = yield* currentToken.pipe(Effect.flip)

        expect(failure).toBeInstanceOf(AuthUnavailable)
      }),
    )
  })

  test.layer(signedIn(NESTED_CLAIM_TOKEN))((it: Tests) => {
    it.effect("fails once the sign-in has expired", () =>
      Effect.gen(function* expired() {
        expect.hasAssertions()

        yield* TestClock.setTime(AFTER_EXPIRY_MILLIS)

        const failure = yield* currentToken.pipe(Effect.flip)

        expect(failure).toBeInstanceOf(AuthUnavailable)
      }),
    )
  })
})
