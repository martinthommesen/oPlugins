import { DateTime, Option, Schema } from "effect"
import ClaudeCredentials from "./claude-credentials.ts"

type Credentials = typeof ClaudeCredentials.Type

// An absolute expiry in epoch milliseconds.
const AbsoluteExpiry = Schema.Struct({ expires_at: Schema.Finite }),
  ERROR_CODE_LIMIT = 200,
  /** A token-endpoint error body whose `error` is the code itself. */
  FlatError = Schema.fromJsonString(Schema.Struct({ error: Schema.String })),
  /** Any JSON document. */
  Json = Schema.fromJsonString(Schema.Unknown),
  MILLIS_PER_SECOND = 1000,
  NO_WAIT = 0,
  /** A token-endpoint error body whose `error` is an object with a `type` code. */
  NestedError = Schema.fromJsonString(
    Schema.Struct({ error: Schema.Struct({ type: Schema.String }) }),
  ),
  /** A relative expiry in seconds. */
  RelativeExpiry = Schema.Struct({
    expires_in: Schema.Finite.check(Schema.isGreaterThan(NO_WAIT)),
  }),
  START = 0,
  /*
   * The tokens in a successful response. A refresh token, when present, must
   * not be blank; when absent the current one stays in use.
   */
  TokenGrant = Schema.Struct({
    access_token: ClaudeCredentials.fields.accessToken,
    refresh_token: Schema.OptionFromOptionalKey(
      ClaudeCredentials.fields.refreshToken,
    ),
  }),
  /*
   * The expiry a successful response states, in epoch milliseconds. An
   * absolute `expires_at` still in the future wins over a relative
   * `expires_in`.
   */
  chosenExpiry = (
    data: Option.Option<unknown>,
    now: number,
  ): Option.Option<number> => {
    const absolute = data.pipe(
        Option.flatMap(Schema.decodeUnknownOption(AbsoluteExpiry)),
        Option.map((body) => body.expires_at),
        Option.filter((at) => at > now),
      ),
      relative = data.pipe(
        Option.flatMap(Schema.decodeUnknownOption(RelativeExpiry)),
        Option.map((body) => now + body.expires_in * MILLIS_PER_SECOND),
      )

    return Option.orElse(absolute, () => relative)
  },
  /*
   * The credentials a successful token response carries, or none when it is
   * not a usable one. A response without a refresh token keeps
   * `currentRefreshToken`.
   */
  credentials = (
    raw: string,
    currentRefreshToken: string,
    now: number,
  ): Option.Option<Credentials> => {
    const data = Schema.decodeOption(Json)(raw),
      grant = data.pipe(Option.flatMap(Schema.decodeUnknownOption(TokenGrant)))

    return Option.all({ expiresAt: chosenExpiry(data, now), grant }).pipe(
      Option.flatMap((found) =>
        Schema.decodeOption(ClaudeCredentials)({
          accessToken: found.grant.access_token,
          expiresAt: Math.trunc(found.expiresAt),
          refreshToken: Option.getOrElse(
            found.grant.refresh_token,
            () => currentRefreshToken,
          ),
        }),
      ),
    )
  },
  /* The OAuth error code in a token-endpoint error body, if it has one. */
  errorCode = (raw: string): Option.Option<string> =>
    Schema.decodeOption(FlatError)(raw).pipe(
      Option.map((body) => body.error),
      Option.orElse(() =>
        Schema.decodeOption(NestedError)(raw).pipe(
          Option.map((body) => body.error.type),
        ),
      ),
      Option.map((code) => code.slice(START, ERROR_CODE_LIMIT)),
    ),
  /*
   * How long a `retry-after` header asks to wait, given as seconds or as an
   * HTTP date, or none when it is absent, already past, or unreadable.
   */
  retryAfterMs = (
    header: Option.Option<string>,
    now: number,
  ): Option.Option<number> =>
    header.pipe(
      Option.flatMap((value) => {
        const seconds = Number(value)

        if (Number.isFinite(seconds) && seconds > NO_WAIT) {
          return Option.some(Math.ceil(seconds * MILLIS_PER_SECOND))
        }

        return DateTime.make(value).pipe(
          Option.map((date) => DateTime.toEpochMillis(date)),
          Option.filter((at) => at > now),
          Option.map((at) => at - now),
        )
      }),
    )

/** Reading the token endpoint's responses. */
export default Object.freeze({ credentials, errorCode, retryAfterMs })
