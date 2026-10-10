import { Effect, Option, Predicate, Schema } from "effect"
import ClaudeCredentials from "./claude-credentials.ts"
import DebugLog from "./debug-log.ts"

type Credentials = typeof ClaudeCredentials.Type

type JsonObject = typeof JsonRecord.Type

/** What a blob holds, as the debug log records it. */
type BlobSummary = Readonly<
  Record<
    "hasAccessToken" | "hasExpiry" | "hasRefreshToken" | "isMcpOnly",
    boolean
  >
>

/** The fields a refresh replaces; everything else in a blob is kept. */
type Tokens = Pick<Credentials, "accessToken" | "expiresAt" | "refreshToken">

const ASTRAL_START = 65_536,
  ESCAPE_WIDTH = 4,
  HEX_RADIX = 16,
  /** Any JSON object, its values kept as they were. */
  JsonRecord = Schema.Record(Schema.String, Schema.Unknown),
  JsonRecordFromString = Schema.fromJsonString(JsonRecord),
  /* Characters `security` would hand back as hex. */
  NON_ASCII = /[\u{7F}-\u{10FFFF}]/gu,
  NO_CODE_POINT = 0,
  SURROGATE_HIGH = 55_296,
  SURROGATE_LOW = 56_320,
  SURROGATE_SPAN = 1024,
  /** The token fields a usable credential must carry. */
  TokenFields = Schema.Struct({
    accessToken: ClaudeCredentials.fields.accessToken,
    expiresAt: ClaudeCredentials.fields.expiresAt,
    refreshToken: ClaudeCredentials.fields.refreshToken,
  }),
  /* The UTF-16 code units of one code point. */
  codeUnits = (codePoint: number): readonly number[] => {
    if (codePoint < ASTRAL_START) {
      return [codePoint]
    }

    const offset = codePoint - ASTRAL_START

    return [
      SURROGATE_HIGH + Math.floor(offset / SURROGATE_SPAN),
      SURROGATE_LOW + (offset % SURROGATE_SPAN),
    ]
  },
  /* The object holding the tokens: `claudeAiOauth` when set, else the root. */
  credentialObject = (root: JsonObject): Option.Option<JsonObject> =>
    Schema.decodeOption(JsonRecord)(
      Option.fromNullishOr(root["claudeAiOauth"]).pipe(
        Option.getOrElse(() => root),
      ),
    ),
  /* `raw` parsed as a JSON object, or none when it is not one. */
  decodeObject = Schema.decodeUnknownOption(JsonRecordFromString),
  /* What a blob holds, for the log, without any of its values. */
  describe = (root: JsonObject, data: JsonObject): BlobSummary => ({
    hasAccessToken: Schema.is(Schema.String)(data["accessToken"]),
    hasExpiry: Schema.is(Schema.Finite)(data["expiresAt"]),
    hasRefreshToken: Schema.is(Schema.String)(data["refreshToken"]),
    isMcpOnly:
      !Predicate.isTruthy(data["accessToken"]) &&
      Predicate.isNotNullish(root["mcpOAuth"]),
  }),
  /* `char` as JSON `\u` escapes. */
  escapeChar = (char: string): string =>
    codeUnits(char.codePointAt(NO_CODE_POINT) ?? NO_CODE_POINT)
      .map(
        (unit) => `\\u${unit.toString(HEX_RADIX).padStart(ESCAPE_WIDTH, "0")}`,
      )
      .join(""),
  /* The credentials `data` carries, or none when it lacks a usable token pair. */
  pairOf = (data: JsonObject): Option.Option<Credentials> =>
    Schema.decodeUnknownOption(TokenFields)(data).pipe(
      Option.map((tokens) => {
        const expiresAt = Math.trunc(tokens.expiresAt)

        return Option.match(
          Schema.decodeUnknownOption(Schema.String)(data["subscriptionType"]),
          {
            onNone: (): Credentials => ({
              accessToken: tokens.accessToken,
              expiresAt,
              refreshToken: tokens.refreshToken,
            }),
            onSome: (subscriptionType): Credentials => ({
              accessToken: tokens.accessToken,
              expiresAt,
              refreshToken: tokens.refreshToken,
              subscriptionType,
            }),
          },
        )
      }),
    ),
  /*
   * The credentials in a stored blob, wrapped in `claudeAiOauth` or at the
   * root, or none when it holds no usable token pair (an mcpOAuth-only
   * blob, say).
   */
  parseCredentials = Effect.fn("ClaudeCredentialsBlob.parse")(function* parse(
    raw: string,
  ) {
    const blob = decodeObject(raw),
      data = blob.pipe(Option.flatMap((root) => credentialObject(root))),
      debug = yield* DebugLog

    if (Option.isNone(blob) || Option.isNone(data)) {
      return Option.none<Credentials>()
    }

    yield* debug.log("credentials_parsed", describe(blob.value, data.value))

    return pairOf(data.value)
  }),
  /*
   * `value` as JSON, escaped to ASCII so a Keychain item stays printable.
   * `security` hands back anything else as hex, which the Claude CLI may
   * not expect.
   */
  printableJson = (value: JsonObject): string =>
    JSON.stringify(value).replaceAll(NON_ASCII, (char) => escapeChar(char)),
  /* `target` with its tokens replaced in place and every other key kept. */
  retokened = (target: JsonObject, tokens: Tokens): JsonObject =>
    Object.fromEntries([
      ...Object.entries(target),
      ["accessToken", tokens.accessToken],
      ["refreshToken", tokens.refreshToken],
      ["expiresAt", tokens.expiresAt],
    ]),
  /*
   * `existing` with its tokens replaced and everything else kept, or none
   * when it is not a credential object this can safely edit.
   */
  updatedBlob = (existing: string, tokens: Tokens): Option.Option<string> =>
    decodeObject(existing).pipe(
      Option.flatMap((root): Option.Option<JsonObject> => {
        const wrapper = root["claudeAiOauth"]

        if (Predicate.isUndefined(wrapper)) {
          return Option.some(retokened(root, tokens))
        }

        return Schema.decodeUnknownOption(JsonRecord)(wrapper).pipe(
          Option.map((inner) =>
            Object.fromEntries([
              ...Object.entries(root),
              ["claudeAiOauth", retokened(inner, tokens)],
            ]),
          ),
        )
      }),
      Option.map((updated) => printableJson(updated)),
    )

/** Reading and editing the JSON blob Claude Code stores credentials in. */
export default Object.freeze({
  parseCredentials,
  updateCredentialBlob: updatedBlob,
})
