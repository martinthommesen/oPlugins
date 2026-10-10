import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Encoding,
  Layer,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
  pipe,
} from "effect"
import { AuthUnavailable } from "./errors/auth-unavailable.ts"
import type { Credential } from "@opencode/plugin/effect"
import { Host } from "./host.ts"
import type { HostError } from "./errors/host-error.ts"

/** What a request to the ChatGPT Codex backend authenticates with. */
interface ChatGptToken {
  readonly accessToken: Redacted.Redacted
  readonly accountId: string
}

interface Interface {
  /** The active OpenAI connection as a ChatGPT token. */
  readonly current: Effect.Effect<ChatGptToken, AuthUnavailable | HostError>
}

const JWT_PAYLOAD_SEGMENT = 1

const AuthClaim = Schema.Struct({
  chatgpt_account_id: Schema.optionalKey(Schema.String),
})

/**
 * Codex reads the account from either claim. OpenCode's legacy Codex sign-in
 * also stores it in the credential metadata.
 */
const Claims = Schema.Struct({
  chatgpt_account_id: Schema.optionalKey(Schema.String),
  "https://api.openai.com/auth": Schema.optionalKey(AuthClaim),
})

const decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims))

const decodeMetadata = Schema.decodeUnknownOption(
  Schema.Struct({ accountID: Schema.String }),
)

const accountIdFromToken = (token: string): Option.Option<string> =>
  pipe(
    token.split("."),
    Arr.get(JWT_PAYLOAD_SEGMENT),
    Option.flatMap((segment) =>
      Result.getSuccess(Encoding.decodeBase64UrlString(segment)),
    ),
    Option.flatMap(decodeClaims),
    Option.flatMap((claims) =>
      Option.firstSomeOf([
        Option.fromUndefinedOr(claims.chatgpt_account_id),
        pipe(
          Option.fromUndefinedOr(claims["https://api.openai.com/auth"]),
          Option.flatMap((auth) =>
            Option.fromUndefinedOr(auth.chatgpt_account_id),
          ),
        ),
      ]),
    ),
  )

const noAccount = (): AuthUnavailable =>
  new AuthUnavailable({
    reason: "The ChatGPT sign-in does not name a ChatGPT account.",
  })

const notConnected = (): AuthUnavailable =>
  new AuthUnavailable({
    reason: "OpenAI is not connected. Run /connect and choose OpenAI.",
  })

const notOAuth = (): Effect.Effect<never, AuthUnavailable> =>
  Effect.fail(
    new AuthUnavailable({
      reason:
        'OpenAI is connected with an API key. Auto-review needs "Sign in with ChatGPT".',
    }),
  )

const fromOAuth = Effect.fn("ChatGptAuth.fromOAuth")(function* fromOAuth(
  oauth: Credential.OAuth,
) {
  const now = yield* Clock.currentTimeMillis

  if (oauth.expires <= now) {
    return yield* new AuthUnavailable({
      reason:
        "The ChatGPT sign-in has expired. OpenCode renews it the next time it sends a request to an OpenAI model.",
    })
  }

  const accountId = Option.firstSomeOf([
    Option.map(
      decodeMetadata(oauth.metadata),
      (metadata) => metadata.accountID,
    ),
    accountIdFromToken(oauth.access),
  ])

  const account = yield* Effect.fromOption(accountId).pipe(
    Effect.mapError(noAccount),
  )

  return { accessToken: Redacted.make(oauth.access), accountId: account }
})

/** Resolves the ChatGPT token the reviewer sends with each request. */
class ChatGptAuth extends Context.Service<ChatGptAuth, Interface>()(
  "opencode-auto-review/ChatGptAuth",
) {
  public static readonly layer = Layer.effect(
    ChatGptAuth,
    Effect.gen(function* makeChatGptAuth() {
      const host = yield* Host

      const current = Effect.gen(function* currentToken() {
        const connected = yield* host.openAiCredential

        const credential = yield* Effect.fromOption(connected).pipe(
          Effect.mapError(notConnected),
        )

        return yield* Match.value(credential).pipe(
          Match.discriminators("type")({
            external: notOAuth,
            key: notOAuth,
            oauth: (oauth: Credential.OAuth) => fromOAuth(oauth),
          }),
          Match.exhaustive,
        )
      })

      return ChatGptAuth.of({ current })
    }),
  )
}

export { ChatGptAuth }

export type { ChatGptToken }
