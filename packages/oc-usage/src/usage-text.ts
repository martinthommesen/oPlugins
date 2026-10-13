import { Array as Arr, Match, Number as Num, Option } from "effect"
import type usageReport from "./usage-report.ts"

type Report = typeof usageReport.UsageReport.Type

type Subscription = Report["subscriptions"][number]

type LimitWindow = typeof usageReport.LimitWindow.Type

type Measured = typeof usageReport.Measured.Type

/** One line of the sidebar section. */
interface Line {
  /** Whether the line names a subscription, which the section shows brighter. */
  readonly emphasis: boolean
  readonly text: string
}

/** How the rows of a subscription's windows read and line up. */
interface Layout {
  /** The time left until a window resets, in words. */
  readonly reset: (left: number) => string
  /** The width of the widest window label. */
  readonly width: number
}

/** What the sidebar section knows: the newest report, and why the newest request for one failed. */
interface View {
  readonly failure: Option.Option<string>
  /** When the section last looked, in epoch milliseconds. */
  readonly now: number
  readonly report: Option.Option<Report>
}

const DAY_MS = 86_400_000,
  HOUR_MS = 3_600_000,
  MINUTE_MS = 60_000,
  NO_TIME = 0,
  NO_WIDTH = 0,
  PERCENT_MAX = 100,
  PERCENT_MIN = 0,
  PERCENT_WIDTH = 4,
  /* A span of time, compactly: `3d 4h`, `2h 14m`, `45m`, or `<1m`. */
  compact = (millis: number): string =>
    Match.value(millis).pipe(
      Match.when(
        (time) => time < MINUTE_MS,
        () => "<1m",
      ),
      Match.when(
        (time) => time < HOUR_MS,
        (time) => `${Math.floor(time / MINUTE_MS)}m`,
      ),
      Match.when(
        (time) => time < DAY_MS,
        (time) =>
          `${Math.floor(time / HOUR_MS)}h ${Math.floor((time % HOUR_MS) / MINUTE_MS)}m`,
      ),
      Match.orElse(
        (time) =>
          `${Math.floor(time / DAY_MS)}d ${Math.floor((time % DAY_MS) / HOUR_MS)}h`,
      ),
    ),
  /* A sidebar line of detail. */
  detail = (text: string): Line => ({ emphasis: false, text }),
  /* The time left until a window resets, as the dialog says it. */
  dialogReset = (left: number): string =>
    Match.value(left).pipe(
      Match.when(NO_TIME, () => "resets now"),
      Match.orElse((time) => `resets in ${compact(time)}`),
    ),
  /* How long ago something happened `millis` ago was. */
  elapsed = (millis: number): string =>
    Match.value(millis).pipe(
      Match.when(
        (time) => time < MINUTE_MS,
        () => "just now",
      ),
      Match.orElse((time) => `${compact(time)} ago`),
    ),
  /* A sidebar line that names a subscription. */
  heading = (text: string): Line => ({ emphasis: true, text }),
  /* A share of a limit used, as a whole percent. */
  percent = (used: Option.Option<number>): string =>
    Option.match(used, {
      onNone: () => "?",
      onSome: (value) =>
        `${Math.round(Num.clamp(value, { maximum: PERCENT_MAX, minimum: PERCENT_MIN }))}%`,
    }),
  /* The subscription's plan, when its newest measurement named one. */
  planOf = (subscription: Subscription): Option.Option<string> =>
    Match.value(subscription.state).pipe(
      Match.tag("Measured", (measured) => measured.plan),
      Match.orElse(() => Option.none<string>()),
    ),
  /* The time left until a window resets, if it said when. */
  remaining = (
    resetsAt: Option.Option<number>,
    now: number,
  ): Option.Option<number> =>
    resetsAt.pipe(Option.map((time) => Math.max(time - now, NO_TIME))),
  /* One window's row: its label, the share used, and the time left. */
  row = (window: LimitWindow, layout: Layout, now: number): string => {
    const reset = remaining(window.resetsAt, now).pipe(
      Option.map((left) => `  ${layout.reset(left)}`),
      Option.getOrElse(() => ""),
    )

    return `${window.label.padEnd(layout.width)}  ${percent(window.usedPercent).padStart(PERCENT_WIDTH)}${reset}`
  },
  /* The rows of a subscription's windows, lined up. */
  rows = (
    windows: readonly LimitWindow[],
    reset: Layout["reset"],
    now: number,
  ): readonly string[] => {
    const width = Math.max(
      NO_WIDTH,
      ...windows.map((window) => window.label.length),
    )

    return windows.map((window) => row(window, { reset, width }, now))
  },
  /* The time left until a window resets, as the sidebar says it. */
  sidebarReset = (left: number): string =>
    Match.value(left).pipe(
      Match.when(NO_TIME, () => "now"),
      Match.orElse((time) => compact(time)),
    ),
  /* A measurement, as the dialog shows it. */
  snapshot = (measured: Measured, now: number): readonly string[] => [
    ...Arr.match(measured.windows, {
      onEmpty: () => ["No usage limits reported."],
      onNonEmpty: (windows) => rows(windows, dialogReset, now),
    }),
    `Measured ${elapsed(now - measured.measuredAt)}.`,
    ...Option.toArray(measured.problem),
  ],
  /* A subscription's state, as the dialog shows it. */
  stateLines = (state: Subscription["state"], now: number): readonly string[] =>
    Match.valueTags(state, {
      Disconnected: ({ hint }) => [`Not connected. ${hint}`],
      Failed: ({ problem }) => [problem],
      Ineligible: ({ reason }) => [reason],
      Measured: (measured) => snapshot(measured, now),
    }),
  /* The subscription's name, and its plan when known. */
  title = (subscription: Subscription): string =>
    Option.match(planOf(subscription), {
      onNone: () => subscription.title,
      onSome: (plan) => `${subscription.title} · ${plan}`,
    }),
  /* The `/usage` dialog's text for `report`, at the time `now`. */
  usageDialog = (report: Report, now: number): string =>
    report.subscriptions
      .flatMap((subscription) => [
        title(subscription),
        ...stateLines(subscription.state, now).map((line) => `  ${line}`),
        "",
      ])
      .join("\n")
      .trimEnd(),
  /*
   * A subscription's lines in the sidebar. A subscription that isn't
   * connected or is ineligible takes no room; failures remain visible.
   */
  usageLines = (
    subscription: Subscription,
    now: number,
    failed: boolean,
  ): readonly Line[] =>
    Match.valueTags(subscription.state, {
      Disconnected: () => [],
      Failed: ({ problem }) => [heading(title(subscription)), detail(problem)],
      Ineligible: () => [],
      Measured: (measured) => [
        heading(title(subscription)),
        ...Arr.match(measured.windows, {
          onEmpty: () => ["No usage limits reported."],
          onNonEmpty: (windows) => rows(windows, sidebarReset, now),
        }).map((text) => detail(text)),
        ...Option.toArray(measured.problem).map((problem) => detail(problem)),
        ...Option.toArray(
          Option.liftPredicate(
            measured,
            () => failed || Option.isSome(measured.problem),
          ),
        ).map(() => detail(`Measured ${elapsed(now - measured.measuredAt)}.`)),
      ],
    }),
  /* The sidebar section's lines, below its heading. */
  usageSidebar = (view: View): readonly Line[] =>
    Option.match(view.report, {
      onNone: () => [
        detail(Option.getOrElse(view.failure, () => "Checking usage…")),
      ],
      onSome: (report) => [
        ...Arr.match(
          report.subscriptions.flatMap((subscription) =>
            usageLines(subscription, view.now, Option.isSome(view.failure)),
          ),
          {
            onEmpty: () => [detail("Connect Claude or ChatGPT with /connect.")],
            onNonEmpty: (lines) => lines,
          },
        ),
        ...Option.toArray(view.failure).map((text) => detail(text)),
      ],
    })

/** The usage report as text, for the `/usage` dialog and the sidebar. */
export default Object.freeze({ usageDialog, usageSidebar })
