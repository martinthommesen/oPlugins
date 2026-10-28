import {
  Array as Arr,
  DateTime,
  Duration,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect"
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
 * The Claude subscription, through the Anthropic connection oc-auth
 * imports from Claude Code. Anthropic's usage endpoint is the one Claude
 * Code's `/usage` reads. It isn't documented, so its answer is decoded
 * leniently: unknown fields are ignored, and a window may be null.
 */
const ANTHROPIC_BETA = "oauth-2025-04-20",
  FIRST = 0,
  INTERVAL_MINUTES = 3,
  NullableNumber = Schema.NullOr(Schema.Finite),
  NullableText = Schema.NullOr(Schema.String),
  /** One usage window, as Anthropic reports it, or null when it doesn't apply. */
  ReportedWindow = Schema.NullOr(
    Schema.Struct({
      resets_at: Schema.optionalKey(NullableText),
      utilization: Schema.optionalKey(NullableNumber),
    }),
  ),
  USAGE_URL = "https://api.anthropic.com/api/oauth/usage",
  /**
   * Anthropic rate-limits usage requests that don't come from Claude Code
   * hard, so oc-usage presents as the Claude Code version oc-auth does.
   */
  USER_AGENT = "claude-code/2.1.295",
  /** Anthropic's answer. The two main windows are required, even if null. */
  UsageResponse = Schema.Struct({
    five_hour: ReportedWindow,
    seven_day: ReportedWindow,
    seven_day_opus: Schema.optionalKey(ReportedWindow),
    seven_day_sonnet: Schema.optionalKey(ReportedWindow),
  }),
  decodeUsage = Schema.decodeUnknownOption(
    Schema.fromJsonString(UsageResponse),
  ),
  /* An ISO 8601 time as epoch milliseconds, if it is one. */
  epochOf = (iso: string | null | undefined): Option.Option<number> =>
    Option.fromNullishOr(iso).pipe(
      Option.flatMap((text) => DateTime.make(text)),
      Option.map((time) => DateTime.toEpochMillis(time)),
    ),
  /* The headers of a usage request with the connection's access token. */
  prepare = (
    access: Access,
  ): Result.Result<Readonly<Record<string, string>>, string> =>
    Result.succeed({
      accept: "application/json",
      "anthropic-beta": ANTHROPIC_BETA,
      authorization: `Bearer ${Redacted.value(access.token)}`,
      "user-agent": USER_AGENT,
    }),
  /* The window Anthropic reported under `label`, if it reported one. */
  reportedWindow = (
    label: string,
    reported: typeof ReportedWindow.Type | undefined,
  ): Option.Option<LimitWindow> =>
    Option.fromNullishOr(reported).pipe(
      Option.map((window) => ({
        label,
        resetsAt: epochOf(window.resets_at),
        usedPercent: Option.fromNullishOr(window.utilization),
      })),
    ),
  /* The usage in Anthropic's answer, or none when the answer isn't one. */
  usageReading = (body: string): Option.Option<Reading> =>
    decodeUsage(body).pipe(
      Option.map((usage) => ({
        plan: Option.none(),
        windows: Arr.getSomes([
          reportedWindow("5-hour", usage.five_hour),
          reportedWindow("Weekly", usage.seven_day),
          reportedWindow("Weekly Opus", usage.seven_day_opus),
          reportedWindow("Weekly Sonnet", usage.seven_day_sonnet),
        ]),
      })),
    )

/** The Claude subscription: where its usage comes from, and how to read it. */
export default Object.freeze({
  account: (): Option.Option<string> => Option.none(),
  hint: "Run /connect, choose Anthropic, and import your Claude Code subscription.",
  ineligible:
    "Anthropic is connected with an API key, which has no subscription usage limits.",
  integrationId: "anthropic",
  interval: Duration.minutes(INTERVAL_MINUTES),
  prepare,
  read: usageReading,
  reconnect: "Run claude to sign in to Claude Code again.",
  service: "Anthropic",
  title: "Claude",
  url: USAGE_URL,
})
