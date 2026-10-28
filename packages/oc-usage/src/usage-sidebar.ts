import {
  Boolean as Bool,
  Clock,
  Effect,
  Option,
  Result,
  Schedule,
} from "effect"
import {
  createDynamic,
  createElement,
  createTextNode,
  effect,
  insertNode,
  setProp,
} from "@opentui/solid"
import { createEffect, createSignal, onCleanup } from "solid-js"
import type { DomNode } from "@opentui/solid"
import type { JSX } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type UsageUnavailable from "./usage-unavailable-error.ts"
import type usageReport from "./usage-report.ts"
import usageText from "./usage-text.ts"

type Report = typeof usageReport.UsageReport.Type

type View = Parameters<typeof usageText.usageSidebar>[typeof FIRST]

type Line = ReturnType<typeof usageText.usageSidebar>[number]

type Outcome = Result.Result<Report, UsageUnavailable>

/*
 * A theme color. OpenTUI's `RGBA` has mutable fields, so the plugin sees it
 * through a read-only slice; it hands the value to the renderer unread.
 */
type Color = Pick<Plugin.Context["theme"]["text"]["muted"], "intent">

/** What the section shows, and where it gets it. */
interface SectionProps {
  /** Every subscription's usage, from the server plugin. */
  readonly fetch: Effect.Effect<Report, UsageUnavailable>
  readonly launch: (program: Effect.Effect<unknown>) => () => void
  readonly stamp: () => string
  readonly theme: {
    readonly text: { readonly base: Color; readonly muted: Color }
  }
}

/*
 * This module is plain TypeScript rather than JSX, so it builds with `tsc`
 * alone. Each helper is what Solid's JSX compiler emits for the matching
 * element, and the host's OpenTUI renderer supplies the functions.
 */
const FIRST = 0,
  NOT_YET = 0,
  /** How often the section asks for the report; the server plugin decides when to ask a service. */
  POLL_INTERVAL = "1 minute",
  // A `<text>` element whose color follows `color`.
  coloredText = (color: () => Color): DomNode => {
    const node = createElement("text")

    effect(() => {
      setProp(node, "fg", color())
    })

    return node
  },
  // The section's bold heading.
  heading = (label: string, color: () => Color): DomNode => {
    const bold = createElement("b"),
      node = coloredText(color)

    insertNode(node, bold)
    insertNode(bold, createTextNode(label))

    return node
  },
  // A `<text>` line of fixed content.
  line = (content: string, color: () => Color): DomNode => {
    const node = coloredText(color)

    insertNode(node, createTextNode(content))

    return node
  },
  // The view after a request came to `outcome` at `now`; a failure keeps the earlier report.
  nextView = (previous: View, outcome: Outcome, now: number): View => ({
    failure: Result.match(outcome, {
      onFailure: (failure: { readonly message: string }) =>
        Option.some(failure.message),
      onSuccess: () => Option.none<string>(),
    }),
    now,
    report: Result.match(outcome, {
      onFailure: () => previous.report,
      onSuccess: (report) => Option.some(report),
    }),
  }),
  // Asks for the report now and every minute after, handing each outcome to `publish`.
  polling = (
    fetch: SectionProps["fetch"],
    publish: (outcome: Outcome, now: number) => void,
  ): Effect.Effect<number> =>
    Effect.all([Effect.result(fetch), Clock.currentTimeMillis]).pipe(
      Effect.flatMap(([outcome, now]: readonly [Outcome, number]) =>
        Effect.sync(() => {
          publish(outcome, now)
        }),
      ),
      Effect.repeat(Schedule.spaced(POLL_INTERVAL)),
    ),
  /*
   * The sidebar's usage section. It asks for the report while it's shown,
   * and stops when the sidebar unmounts it.
   */
  section = (props: SectionProps): JSX.Element => {
    const [view, setView] = createSignal<View>({
        failure: Option.none(),
        now: NOT_YET,
        report: Option.none(),
      }),
      toNode = (text: Line): DomNode =>
        line(text.text, () =>
          Bool.match(text.emphasis, {
            onFalse: () => props.theme.text.muted,
            onTrue: () => props.theme.text.base,
          }),
        )

    createEffect(() => {
      props.stamp()
      setView({ failure: Option.none(), now: NOT_YET, report: Option.none() })

      const stop = props.launch(
        polling(props.fetch, (outcome, now) => {
          setView((previous) => nextView(previous, outcome, now))
        }),
      )

      onCleanup(stop)
    })

    return createDynamic(() => "box", {
      get children() {
        return [
          heading("Usage", () => props.theme.text.base),
          ...usageText.usageSidebar(view()).map((text) => toNode(text)),
        ]
      },
    })
  }

/** The sidebar's usage section. */
export default Object.freeze({ section })
