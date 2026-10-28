import { Option, Redacted, Result } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Base64Url } from "effect/encoding"
import codexUsage from "./codex-usage.ts"

const FIVE_HOUR_RESET_MS = 1_791_892_800_000,
  FIVE_HOUR_USED = 12,
  /** A Plus plan's answer, with the weekly window first, as positions don't name windows. */
  PLUS_ANSWER =
    '{"additional_rate_limits":[{"limit_name":"GPT-5.3-Codex-Spark","metered_feature":"codex_bengalfox","rate_limit":{"primary_window":{"limit_window_seconds":18000,"reset_at":1791892800,"used_percent":7},"secondary_window":null}}],"credits":{"has_credits":false},"plan_type":"plus","rate_limit":{"allowed":true,"limit_reached":false,"primary_window":{"limit_window_seconds":604800,"reset_after_seconds":3600,"reset_at":1792198800,"used_percent":40},"secondary_window":{"limit_window_seconds":18000,"reset_at":1791892800,"used_percent":12}}}',
  SPARK_USED = 7,
  /** A plan with one weekly window and no model limits. */
  TEAM_ANSWER =
    '{"additional_rate_limits":null,"plan_type":"self_serve_business","rate_limit":{"primary_window":{"limit_window_seconds":604800,"used_percent":9},"secondary_window":null}}',
  TEAM_USED = 9,
  WEEKLY_RESET_MS = 1_792_198_800_000,
  WEEKLY_USED = 40,
  /** What oc-usage reads from `PLUS_ANSWER`. */
  WINDOWS_PLUS = Option.some({
    plan: Option.some("Plus"),
    windows: [
      {
        label: "5-hour",
        resetsAt: Option.some(FIVE_HOUR_RESET_MS),
        usedPercent: Option.some(FIVE_HOUR_USED),
      },
      {
        label: "Weekly",
        resetsAt: Option.some(WEEKLY_RESET_MS),
        usedPercent: Option.some(WEEKLY_USED),
      },
      {
        label: "GPT-5.3-Codex-Spark 5-hour",
        resetsAt: Option.some(FIVE_HOUR_RESET_MS),
        usedPercent: Option.some(SPARK_USED),
      },
    ],
  }),
  /** What oc-usage reads from `TEAM_ANSWER`. */
  WINDOWS_TEAM = Option.some({
    plan: Option.some("Self serve business"),
    windows: [
      {
        label: "Weekly",
        resetsAt: Option.none(),
        usedPercent: Option.some(TEAM_USED),
      },
    ],
  }),
  /* An unsigned JWT access token with the claims `claims`, as JSON. */
  jwt = (claims: string): string =>
    [
      Base64Url.encode('{"alg":"none"}'),
      Base64Url.encode(claims),
      "signature",
    ].join("."),
  /*
   * The account a usage request names for a sign-in whose metadata names
   * `accountId`, and whose access token has `claims`, or why there's none.
   */
  namedAccount = (
    accountId: Option.Option<string>,
    claims: string,
  ): Result.Result<string | undefined, string> =>
    codexUsage
      .prepare({ accountId, token: Redacted.make(jwt(claims)) })
      .pipe(Result.map((headers) => headers["chatgpt-account-id"]))

describe("the Codex usage answer", () => {
  it(
    "names each window by its length, shortest first, and reads the plan",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(codexUsage.read(PLUS_ANSWER)).toStrictEqual(WINDOWS_PLUS)
    },
  )

  it(
    "reads a plan with one weekly window and no model limits",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(codexUsage.read(TEAM_ANSWER)).toStrictEqual(WINDOWS_TEAM)
    },
  )
})

describe("an unexpected Codex usage answer", () => {
  it(
    "drops an overflowing reset timestamp without losing usage",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        codexUsage
          .read(
            '{"plan_type":"plus","rate_limit":{"primary_window":{"limit_window_seconds":18000,"reset_at":1e308,"used_percent":12}}}',
          )
          .pipe(Option.map((reading) => reading.windows)),
      ).toStrictEqual(
        Option.some([
          {
            label: "5-hour",
            resetsAt: Option.none(),
            usedPercent: Option.some(FIVE_HOUR_USED),
          },
        ]),
      )
    },
  )
})

describe("optional Codex limits", () => {
  it(
    "keeps the main limits when the model limits change shape",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        codexUsage.read(
          '{"additional_rate_limits":[{"id":"codex-spark"}],"plan_type":"prolite","rate_limit":{"primary_window":{"limit_window_seconds":18000,"used_percent":12}}}',
        ),
      ).toStrictEqual(
        Option.some({
          plan: Option.some("Pro Lite"),
          windows: [
            {
              label: "5-hour",
              resetsAt: Option.none(),
              usedPercent: Option.some(FIVE_HOUR_USED),
            },
          ],
        }),
      )
    },
  )

  it(
    "isn't read without a plan, or when it isn't JSON",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(codexUsage.read("{}")).toStrictEqual(Option.none())
      expect(codexUsage.read("<html>")).toStrictEqual(Option.none())
    },
  )
})

describe("a Codex usage request", () => {
  it(
    "names the account the sign-in's metadata names",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        namedAccount(
          Option.some("acct-meta"),
          '{"chatgpt_account_id":"acct-jwt"}',
        ),
      ).toStrictEqual(Result.succeed("acct-meta"))
    },
  )

  it(
    "falls back to the account the access token names",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        namedAccount(
          Option.none(),
          '{"https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"}}',
        ),
      ).toStrictEqual(Result.succeed("acct-1"))
    },
  )
})

describe("a Codex usage request for a sign-in that names no account", () => {
  it(
    "ignores an empty metadata account and uses the token",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        namedAccount(Option.some(""), '{"chatgpt_account_id":"acct-1"}'),
      ).toStrictEqual(Result.succeed("acct-1"))
    },
  )

  it("can't go out", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(namedAccount(Option.none(), '{"sub":"user"}')).toStrictEqual(
      Result.fail(
        "The ChatGPT sign-in doesn't name a ChatGPT account. Reconnect OpenAI with /connect.",
      ),
    )
  })
})
