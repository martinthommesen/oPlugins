import {
  Array as Arr,
  Clock,
  Context,
  Effect,
  Layer,
  Match,
  Option,
  Redacted,
  Result,
  Schema,
  pipe,
} from "effect"
import AuthUnavailable from "./auth-unavailable-error.ts"
import { Base64Url } from "effect/encoding"
import type { Credential } from "@opencode/plugin/effect"
import Host from "./host.ts"
import type HostError from "./host-error.ts"

/** What a request to the ChatGPT Codex backend authenticates with. */
interface ChatGptToken {
  readonly accessToken: Redacted.Redacted
  readonly accountId: string
}

interface Interface {
  /** The active OpenAI connection as a ChatGPT token. */
  readonly current: Effect.Effect<ChatGptToken, AuthUnavailable | HostError>
}

const AuthClaim = Schema.Struct({
    chatgpt_account_id: Schema.optionalKey(Schema.String),
  }),
  /**
   * Codex reads the account from either claim. OpenCode's legacy Codex sign-in
   * also stores it in the credential metadata.
   */
  Claims = Schema.Struct({
    chatgpt_account_id: Schema.optionalKey(Schema.String),
    "https://api.openai.com/auth": Schema.optionalKey(AuthClaim),
  }),
  JWT_PAYLOAD_SEGMENT = 1,
  decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims)),
  decodeMetadata = Schema.decodeUnknownOption(
    Schema.Struct({ accountID: Schema.String }),
  ),
  /* The ChatGPT account a JWT access token names, if any. */
  jwtAccountId = (token: string): Option.Option<string> =>
    pipe(
      token.split("."),
      Arr.get(JWT_PAYLOAD_SEGMENT),
      Option.flatMap((segment) =>
        Result.getSuccess(Base64Url.decodeString(segment)),
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
    ),
  noAccount = (): AuthUnavailable =>
    AuthUnavailable.make({
      reason:
        "The ChatGPT sign-in does not name a ChatGPT account. Reconnect OpenAI with /connect.",
    }),
  notConnected = (): AuthUnavailable =>
    AuthUnavailable.make({
      reason: "OpenAI is not connected. Run /connect and choose OpenAI.",
    }),
  notOAuth = (): Effect.Effect<never, AuthUnavailable> =>
    Effect.fail(
      AuthUnavailable.make({
        reason:
          'OpenAI is connected with an API key, but Auto-review needs "Sign in with ChatGPT". Run /connect and choose OpenAI.',
      }),
    ),
  /* The token an unexpired ChatGPT sign-in authenticates with. */
  oauthToken = Effect.fn("ChatGptAuth.oauthToken")(function* oauthToken(
    oauth: Credential.OAuth,
  ) {
    const accountId = Option.firstSomeOf([
        Option.map(
          decodeMetadata(oauth.metadata),
          (metadata) => metadata.accountID,
        ),
        jwtAccountId(oauth.access),
      ]),
      now = yield* Clock.currentTimeMillis

    if (oauth.expires <= now) {
      return yield* AuthUnavailable.make({
        reason:
          "The ChatGPT sign-in has expired. OpenCode renews it the next time it sends a request to an OpenAI model.",
      })
    }

    return {
      accessToken: Redacted.make(oauth.access),
      accountId: yield* Effect.fromOption(accountId).pipe(
        Effect.mapError(noAccount),
      ),
    }
  })

/** Resolves the ChatGPT token the reviewer sends with each request. */
class ChatGptAuth extends Context.Service<ChatGptAuth, Interface>()(
  "@martinthommesen/oc-auto/chatgpt-auth/ChatGptAuth",
) {
  public static readonly layer = Layer.effect(
    ChatGptAuth,
    Effect.gen(function* makeChatGptAuth() {
      const host = yield* Host

      return ChatGptAuth.of({
        current: Effect.gen(function* currentToken() {
          const connected = yield* host.openAiCredential,
            credential = yield* Effect.fromOption(connected).pipe(
              Effect.mapError(notConnected),
            )

          return yield* Match.value(credential).pipe(
            Match.discriminators("type")({
              external: notOAuth,
              key: notOAuth,
              oauth: (oauth: Credential.OAuth) => oauthToken(oauth),
            }),
            Match.exhaustive,
          )
        }),
      })
    }),
  )
}

export default ChatGptAuth
