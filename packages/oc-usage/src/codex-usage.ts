import {
  Array as Arr,
  Duration,
  Match,
  Option,
  Order,
  Redacted,
  Result,
  Schema,
  String as Str,
  pipe,
} from "effect"
import { Base64Url } from "effect/encoding"
import type { Effect } from "effect"
import type Host from "./host.ts"
import type UsageMeter from "./usage-meter.ts"

type SignIn = Option.Option.Value<
  Effect.Success<ReturnType<Host["Service"]["signIn"]>>
>

type Access = Option.Option.Value<Effect.Success<SignIn["access"]>>

type Reading = Option.Option.Value<
  ReturnType<Parameters<UsageMeter["Service"]["measure"]>[typeof FIRST]["read"]>
>

type LimitWindow = Reading["windows"][number]

/*
 * The ChatGPT subscription's Codex usage limits, through OpenCode's own
 * "Sign in with ChatGPT" OpenAI connection. The endpoint is the one the
 * Codex CLI reads. It isn't documented, so its answer is decoded
 * leniently, and a window is named by its length, never its position.
 */
const AuthClaim = Schema.Struct({
    chatgpt_account_id: Schema.optionalKey(Schema.NonEmptyString),
  }),
  /** The claims of the access token that can name the ChatGPT account. */
  Claims = Schema.Struct({
    chatgpt_account_id: Schema.optionalKey(Schema.NonEmptyString),
    "https://api.openai.com/auth": Schema.optionalKey(AuthClaim),
  }),
  DAY_SECONDS = 86_400,
  FIRST = 0,
  HOUR_SECONDS = 3600,
  INTERVAL_MINUTES = 1,
  JWT_PAYLOAD_SEGMENT = 1,
  /** One usage window, as the backend reports it. */
  LimitWindowResponse = Schema.Struct({
    limit_window_seconds: Schema.Finite.check(Schema.isGreaterThan(FIRST)),
    reset_at: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
    used_percent: Schema.optionalKey(Schema.NullOr(Schema.Finite)),
  }),
  MILLIS_PER_SECOND = 1000,
  MINUTE_SECONDS = 60,
  NO_REMAINDER = 0,
  OptionalWindow = Schema.optionalKey(Schema.NullOr(LimitWindowResponse)),
  /** A rate limit's windows; either may be absent. */
  RateLimit = Schema.NullOr(
    Schema.Struct({
      primary_window: OptionalWindow,
      secondary_window: OptionalWindow,
    }),
  ),
  /** The limits specific to one model, such as Codex Spark's. */
  SpecificLimit = Schema.Struct({
    limit_name: Schema.String,
    rate_limit: Schema.optionalKey(RateLimit),
  }),
  /**
   * Every model's specific limits. They're decoded apart from the rest of
   * the answer, so a change to them can't hide the main limits.
   */
  SpecificLimits = Schema.Struct({
    additional_rate_limits: Schema.Array(SpecificLimit),
  }),
  USAGE_URL = "https://chatgpt.com/backend-api/wham/usage",
  /** The backend's answer. It must name the plan. */
  UsageResponse = Schema.Struct({
    plan_type: Schema.String,
    rate_limit: Schema.optionalKey(RateLimit),
  }),
  WEEK_SECONDS = 604_800,
  decodeClaims = Schema.decodeUnknownOption(Schema.fromJsonString(Claims)),
  decodeSpecific = Schema.decodeUnknownOption(
    Schema.fromJsonString(SpecificLimits),
  ),
  decodeUsage = Schema.decodeUnknownOption(
    Schema.fromJsonString(UsageResponse),
  ),
  /* A window's name, from its length. */
  durationLabel = (seconds: number): string =>
    Match.value(seconds).pipe(
      Match.when(WEEK_SECONDS, () => "Weekly"),
      Match.when(DAY_SECONDS, () => "Daily"),
      Match.when(
        (length) => length % DAY_SECONDS === NO_REMAINDER,
        (length) => `${length / DAY_SECONDS}-day`,
      ),
      Match.when(
        (length) => length % HOUR_SECONDS === NO_REMAINDER,
        (length) => `${length / HOUR_SECONDS}-hour`,
      ),
      Match.orElse((length) => `${Math.round(length / MINUTE_SECONDS)}-minute`),
    ),
  hasAccountId = Option.filter(Schema.is(Schema.NonEmptyString)),
  /* The ChatGPT account an access token's claims name, if any. */
  jwtAccountId = (token: string): Option.Option<string> =>
    pipe(
      Arr.get(token.split("."), JWT_PAYLOAD_SEGMENT),
      Option.flatMap((segment) =>
        Result.getSuccess(Base64Url.decodeString(segment)),
      ),
      Option.flatMap(decodeClaims),
      Option.flatMap((claims) =>
        Option.firstSomeOf([
          Option.fromUndefinedOr(claims.chatgpt_account_id),
          Option.fromUndefinedOr(claims["https://api.openai.com/auth"]).pipe(
            Option.flatMap((auth) =>
              Option.fromUndefinedOr(auth.chatgpt_account_id),
            ),
          ),
        ]),
      ),
    ),
  /* One of a rate limit's windows, named by its length after `prefix`. */
  limitWindow = (
    prefix: string,
    window: typeof LimitWindowResponse.Type,
  ): LimitWindow => ({
    label: Str.trim(`${prefix} ${durationLabel(window.limit_window_seconds)}`),
    resetsAt: Option.fromNullishOr(window.reset_at).pipe(
      Option.map((seconds) => seconds * MILLIS_PER_SECOND),
      Option.flatMap(Schema.decodeUnknownOption(Schema.Finite)),
    ),
    usedPercent: Option.fromNullishOr(window.used_percent),
  }),
  /* The plan's name, such as `Plus`. */
  planName = (plan: string): string =>
    Match.value(plan).pipe(
      Match.when("prolite", () => "Pro Lite"),
      Match.when("promax", () => "Pro Max"),
      Match.orElse((other) => Str.capitalize(other.replaceAll("_", " "))),
    ),
  /*
   * The headers of a usage request, which must name the ChatGPT account: the
   * one the sign-in's metadata names, or else its access token.
   */
  prepare = (
    access: Access,
  ): Result.Result<Readonly<Record<string, string>>, string> =>
    Option.match(
      Option.orElse(hasAccountId(access.accountId), () =>
        jwtAccountId(Redacted.value(access.token)),
      ),
      {
        onNone: () =>
          Result.fail(
            "The ChatGPT sign-in doesn't name a ChatGPT account. Reconnect OpenAI with /connect.",
          ),
        onSome: (accountId) =>
          Result.succeed({
            accept: "application/json",
            authorization: `Bearer ${Redacted.value(access.token)}`,
            "chatgpt-account-id": accountId,
            originator: "opencode",
          }),
      },
    ),
  /* A rate limit's windows, shortest first. */
  rateWindows = (
    prefix: string,
    limit: typeof RateLimit.Type | undefined,
  ): readonly LimitWindow[] =>
    Option.fromNullishOr(limit).pipe(
      Option.map((windows) =>
        Arr.getSomes([
          Option.fromNullishOr(windows.primary_window),
          Option.fromNullishOr(windows.secondary_window),
        ]),
      ),
      Option.getOrElse(() => []),
      Arr.sortBy(
        Order.mapInput(
          Order.Number,
          (window: typeof LimitWindowResponse.Type) =>
            window.limit_window_seconds,
        ),
      ),
      Arr.map((window) => limitWindow(prefix, window)),
    ),
  /* The windows of the limits specific to one model, if the answer has any. */
  specificWindows = (body: string): readonly LimitWindow[] =>
    decodeSpecific(body).pipe(
      Option.map((specific) =>
        specific.additional_rate_limits.flatMap((limit) =>
          rateWindows(limit.limit_name, limit.rate_limit),
        ),
      ),
      Option.getOrElse(() => []),
    ),
  /* The usage in the backend's answer, or none when the answer isn't one. */
  usageReading = (body: string): Option.Option<Reading> =>
    decodeUsage(body).pipe(
      Option.map((usage) => ({
        plan: Option.some(planName(usage.plan_type)),
        windows: [
          ...rateWindows("", usage.rate_limit),
          ...specificWindows(body),
        ],
      })),
    )

/** The Codex limits of a ChatGPT subscription: where they come from, and how to read them. */
export default Object.freeze({
  hint: "Run /connect, choose OpenAI, and sign in with ChatGPT.",
  ineligible:
    "OpenAI is connected with an API key, which has no ChatGPT usage limits.",
  integrationId: "openai",
  interval: Duration.minutes(INTERVAL_MINUTES),
  prepare,
  read: usageReading,
  reconnect: "Reconnect OpenAI with /connect.",
  service: "ChatGPT",
  title: "Codex",
  url: USAGE_URL,
})
