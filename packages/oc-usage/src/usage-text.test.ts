import { Boolean as Bool, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import usageReport from "./usage-report.ts"
import usageText from "./usage-text.ts"

type Report = Parameters<typeof usageText.usageDialog>[typeof FIRST]

const CLAUDE_AGE_MS = 180_000,
  CODEX_AGE_MS = 720_000,
  CODEX_LEFT_MS = 2_700_000,
  FIRST = 0,
  FIVE_HOUR_LEFT_MS = 8_040_000,
  FIVE_HOUR_USED = 34,
  MINUTE_MS = 60_000,
  NOW = 1_791_880_000_000,
  OVER_LIMIT = 112,
  SONNET_USED = 3,
  WEEKLY_LEFT_MS = 273_600_000,
  WEEKLY_USED = 61.5,
  /** Claude's measurement, 3 minutes old. */
  claude = {
    state: usageReport.Measured.make({
      measuredAt: NOW - CLAUDE_AGE_MS,
      plan: Option.none(),
      problem: Option.none(),
      windows: [
        {
          label: "5-hour",
          resetsAt: Option.some(NOW + FIVE_HOUR_LEFT_MS),
          usedPercent: Option.some(FIVE_HOUR_USED),
        },
        {
          label: "Weekly",
          resetsAt: Option.some(NOW + WEEKLY_LEFT_MS),
          usedPercent: Option.some(WEEKLY_USED),
        },
        {
          label: "Weekly Sonnet",
          resetsAt: Option.none(),
          usedPercent: Option.some(SONNET_USED),
        },
      ],
    }),
    title: "Claude",
  },
  /** ChatGPT's measurement, 12 minutes old, because the newest request failed. */
  codex = {
    state: usageReport.Measured.make({
      measuredAt: NOW - CODEX_AGE_MS,
      plan: Option.some("Plus"),
      problem: Option.some("ChatGPT answered with HTTP 503."),
      windows: [
        {
          label: "5-hour",
          resetsAt: Option.some(NOW + CODEX_LEFT_MS),
          usedPercent: Option.some(OVER_LIMIT),
        },
        {
          label: "Weekly",
          resetsAt: Option.some(NOW - MINUTE_MS),
          usedPercent: Option.none(),
        },
      ],
    }),
    title: "Codex",
  },
  /* The sidebar's lines for `report`, each subscription's name marked with `*`. */
  sidebarText = (
    report: Option.Option<Report>,
    failure: Option.Option<string>,
  ): readonly string[] =>
    usageText
      .usageSidebar({ failure, now: NOW, report })
      .map(
        (line) =>
          `${Bool.match(line.emphasis, { onFalse: () => " ", onTrue: () => "*" })} ${line.text}`,
      ),
  /** A report with neither subscription measured. */
  unmeasured: Report = {
    subscriptions: [
      {
        state: usageReport.Disconnected.make({ hint: "Run /connect." }),
        title: "Claude",
      },
      {
        state: usageReport.Ineligible.make({ reason: "It's an API key." }),
        title: "Codex",
      },
    ],
  }

describe("the /usage dialog", () => {
  it(
    "dates retained measurements after an RPC failure",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        sidebarText(
          Option.some({ subscriptions: [claude] }),
          Option.some("RPC failed"),
        ),
      ).toContain("  Measured 3m ago.")
    },
  )
})

describe("subscription usage formatting", () => {
  it(
    "lines up each subscription's windows, with their age and problem",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        usageText.usageDialog({ subscriptions: [claude, codex] }, NOW),
      ).toBe(
        [
          "Claude",
          "  5-hour          34%  resets in 2h 14m",
          "  Weekly          62%  resets in 3d 4h",
          "  Weekly Sonnet    3%",
          "  Measured 3m ago.",
          "",
          "Codex · Plus",
          "  5-hour  100%  resets in 45m",
          "  Weekly     ?  resets now",
          "  Measured 12m ago.",
          "  ChatGPT answered with HTTP 503.",
        ].join("\n"),
      )
    },
  )

  it(
    "says what to do for each subscription it can't measure",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(usageText.usageDialog(unmeasured, NOW)).toBe(
        [
          "Claude",
          "  Not connected. Run /connect.",
          "",
          "Codex",
          "  It's an API key.",
        ].join("\n"),
      )
    },
  )
})

describe("the sidebar section with a report", () => {
  it(
    "shows each measured subscription, and how old a stale one is",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        sidebarText(
          Option.some({ subscriptions: [claude, codex] }),
          Option.none(),
        ),
      ).toStrictEqual([
        "* Claude",
        "  5-hour          34%  2h 14m",
        "  Weekly          62%  3d 4h",
        "  Weekly Sonnet    3%",
        "* Codex · Plus",
        "  5-hour  100%  45m",
        "  Weekly     ?  now",
        "  ChatGPT answered with HTTP 503.",
        "  Measured 12m ago.",
      ])
    },
  )
})

describe("the sidebar section without measurements", () => {
  it(
    "leaves out subscriptions it can't measure, and says how to connect",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(sidebarText(Option.some(unmeasured), Option.none())).toStrictEqual(
        ["  Connect Claude or ChatGPT with /connect."],
      )
    },
  )

  it(
    "keeps the last report when a newer request fails",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        sidebarText(Option.some(unmeasured), Option.some("No answer.")),
      ).toStrictEqual([
        "  Connect Claude or ChatGPT with /connect.",
        "  No answer.",
      ])
    },
  )
})

describe("the sidebar section before its first report", () => {
  it("says it's checking, or why it can't", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(sidebarText(Option.none(), Option.none())).toStrictEqual([
      "  Checking usage…",
    ])
    expect(sidebarText(Option.none(), Option.some("No answer."))).toStrictEqual(
      ["  No answer."],
    )
  })
})
