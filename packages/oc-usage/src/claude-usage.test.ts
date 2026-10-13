import { Option, Redacted, Result } from "effect"
import { describe, expect, it } from "@effect/vitest"
import claudeUsage from "./claude-usage.ts"

const FIVE_HOUR_RESET = 1_791_892_800_500,
  FIVE_HOUR_USED = 34,
  /** Anthropic's answer for a Max plan, with fields oc-usage doesn't read. */
  FULL_ANSWER =
    '{"extra_usage":{"is_enabled":false},"five_hour":{"resets_at":"2026-10-13T12:00:00.500+00:00","utilization":34},"iguana_necktie":null,"seven_day":{"resets_at":"2026-10-17T01:00:00Z","utilization":61.5},"seven_day_opus":null,"seven_day_sonnet":{"resets_at":null,"utilization":3}}',
  SONNET_USED = 3,
  /** What oc-usage reads from a window that reports no utilization. */
  UNKNOWN_READING = Option.some({
    plan: Option.none(),
    windows: [
      { label: "5-hour", resetsAt: Option.none(), usedPercent: Option.none() },
    ],
  }),
  WEEKLY_RESET = 1_792_198_800_000,
  WEEKLY_USED = 61.5,
  /** What oc-usage reads from `FULL_ANSWER`. */
  WINDOWS_READ = Option.some({
    plan: Option.none(),
    windows: [
      {
        label: "5-hour",
        resetsAt: Option.some(FIVE_HOUR_RESET),
        usedPercent: Option.some(FIVE_HOUR_USED),
      },
      {
        label: "Weekly",
        resetsAt: Option.some(WEEKLY_RESET),
        usedPercent: Option.some(WEEKLY_USED),
      },
      {
        label: "Weekly Sonnet",
        resetsAt: Option.none(),
        usedPercent: Option.some(SONNET_USED),
      },
    ],
  })

describe("the answer of Anthropic's usage endpoint", () => {
  it(
    "is read window by window, leaving out a null one",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(claudeUsage.read(FULL_ANSWER)).toStrictEqual(WINDOWS_READ)
    },
  )

  it(
    "reads a window without utilization as unknown, not zero",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        claudeUsage.read('{"five_hour":{"resets_at":"soon"},"seven_day":null}'),
      ).toStrictEqual(UNKNOWN_READING)
    },
  )

  it(
    "isn't read without its main windows, or when it isn't JSON",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(claudeUsage.read("{}")).toStrictEqual(Option.none())
      expect(claudeUsage.read("<html>")).toStrictEqual(Option.none())
      expect(
        claudeUsage.read('{"five_hour":34,"seven_day":null}'),
      ).toStrictEqual(Option.none())
    },
  )
})

describe("a usage request to Anthropic", () => {
  it(
    "carries the OAuth token and presents as Claude Code",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        claudeUsage.prepare({
          accountId: Option.none(),
          token: Redacted.make("sk-ant-oat01-test"),
        }),
      ).toStrictEqual(
        Result.succeed({
          accept: "application/json",
          "anthropic-beta": "oauth-2025-04-20",
          authorization: "Bearer sk-ant-oat01-test",
          "user-agent": "claude-code/2.1.295",
        }),
      )
    },
  )
})
