import { Array as Arr, Option, Redacted, Result, Schema, pipe } from "effect"
import { Base64Url } from "effect/encoding"

interface Access {
  readonly accountId: Option.Option<string>
  readonly token: Redacted.Redacted
}

const AccountId = Schema.NonEmptyString.check(
    Schema.isPattern(/^[^\p{Cc}\p{Cf}\s]+$/u),
  ),
  Auth = Schema.Struct({
    chatgpt_account_id: Schema.optionalKey(Schema.Unknown),
  }),
  Claims = Schema.Struct({
    chatgpt_account_id: Schema.optionalKey(Schema.Unknown),
    "https://api.openai.com/auth": Schema.optionalKey(Schema.Unknown),
  }),
  PAYLOAD = 1,
  decodeAccount = Schema.decodeUnknownOption(AccountId),
  decodeAuth = Schema.decodeUnknownOption(Auth),
  decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims)),
  /* Candidate claim paths are decoded independently so a malformed optional path cannot veto another. */
  fromToken = (token: Redacted.Redacted): Option.Option<string> =>
    pipe(
      Arr.get(Redacted.value(token).split("."), PAYLOAD),
      Option.flatMap((segment) =>
        Result.getSuccess(Base64Url.decodeString(segment)),
      ),
      Option.flatMap(decodeClaims),
      Option.flatMap((claims) =>
        Option.firstSomeOf([
          decodeAccount(claims.chatgpt_account_id),
          decodeAuth(claims["https://api.openai.com/auth"]).pipe(
            Option.flatMap((auth) => decodeAccount(auth.chatgpt_account_id)),
          ),
        ]),
      ),
    ),
  /* The same account selection determines both the request header and its measurement identity. */
  named = (access: Access): Option.Option<string> =>
    access.accountId.pipe(
      Option.flatMap(decodeAccount),
      Option.orElse(() => fromToken(access.token)),
    )

export default Object.freeze({ named })
