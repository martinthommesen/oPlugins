import type { Accessor, JSX } from "solid-js"
import { Show, createComponent, createMemo } from "solid-js"
import {
  createDynamic,
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
} from "@opentui/solid"
import type { DomNode } from "@opentui/solid"
import { Option } from "effect"
import type { Plugin } from "@opencode/plugin/tui"
import cache from "./cache-stats.ts"

type Context = Plugin.Context

type CacheStats = Option.Option.Value<ReturnType<typeof cache.cacheStats>>

/*
 * A theme color. OpenTUI's `RGBA` has mutable fields, so the plugin sees it
 * through a read-only slice; it hands the value to the renderer unread.
 */
type Color = Pick<Context["theme"]["text"]["muted"], "intent">

type KeymapLayer = Context["keymap"]["layer"] extends (
  factory: () => infer Layer,
) => void
  ? Layer
  : never

type RunResult = ReturnType<NonNullable<KeymapLayer["commands"]>[number]["run"]>

type Messages = typeof cache.lastRequestStats extends (
  messages?: infer List,
) => object
  ? List
  : never

type TokenUsage = typeof cache.cacheStats extends (
  tokens?: infer Usage,
) => object
  ? Usage
  : never

/** The parts of the CLI plugin context this plugin uses, read-only. */
interface Host {
  readonly data: {
    readonly session: {
      readonly get: (
        sessionID: string,
      ) => { readonly tokens: TokenUsage } | undefined
      readonly message: { readonly list: (sessionID: string) => Messages }
    }
  }
  readonly keymap: { readonly layer: Context["keymap"]["layer"] }
  readonly theme: {
    readonly text: { readonly base: Color; readonly muted: Color }
  }
  readonly ui: {
    readonly dialog: { readonly alert: Context["ui"]["dialog"]["alert"] }
    readonly router: { readonly current: Context["ui"]["router"]["current"] }
    readonly slot: Context["ui"]["slot"]
    readonly toast: { readonly show: Context["ui"]["toast"]["show"] }
  }
}

/** Cache statistics for a whole session and for its newest request. */
interface SessionStats {
  readonly last: Option.Option<CacheStats>
  readonly session: Option.Option<CacheStats>
}

/*
 * This module is plain TypeScript rather than JSX, so it builds with `tsc`
 * alone. Each helper is what Solid's JSX compiler emits for the matching
 * element, and the host's OpenTUI renderer supplies the functions.
 */
// A `<text>` element whose color follows `color`.
const coloredText = (color: () => Color): DomNode => {
    const node = createElement("text")

    effect(() => {
      setProp(node, "fg", color())
    })

    return node
  },
  heading = (label: string, color: () => Color): DomNode => {
    const bold = createElement("b"),
      node = coloredText(color)

    insertNode(node, bold)
    insertNode(bold, createTextNode(label))

    return node
  },
  // A `<text>` line whose content follows `content`.
  line = (content: () => string, color: () => Color): DomNode => {
    const node = coloredText(color)

    insert(node, content)

    return node
  },
  readStats = (context: Host, sessionID: string): SessionStats => ({
    last: cache.lastRequestStats(context.data.session.message.list(sessionID)),
    session: Option.fromNullishOr(context.data.session.get(sessionID)).pipe(
      Option.flatMap((info: { readonly tokens: TokenUsage }) =>
        cache.cacheStats(info.tokens),
      ),
    ),
  }),
  reportLines = (stats: Option.Option<CacheStats>, label: string): string[] =>
    Option.match(stats, {
      onNone: () => [`${label}: no prompt tokens yet`],
      onSome: (value) => [
        `${label}: ${cache.formatRates(value)}`,
        `  ${cache.formatBreakdown(value)}`,
      ],
    }),
  // The sidebar's cache section, shown once the session has used a prompt.
  section = (props: {
    readonly context: Host
    readonly sessionID: string
  }): JSX.Element => {
    const { context } = props,
      muted = (): Color => context.theme.text.muted,
      stats = createMemo(() => readStats(context, props.sessionID))

    return createComponent<{
      readonly children: (session: Accessor<CacheStats>) => JSX.Element
      readonly when: CacheStats | undefined
    }>(Show, {
      children: (session: Accessor<CacheStats>) => {
        const fixed = [
          heading("Cache", () => context.theme.text.base),
          line(() => cache.formatRates(session()), muted),
          line(() => cache.formatBreakdown(session()), muted),
        ]

        /*
         * Compiled JSX would append the optional line with a `null` marker.
         * One array of every child needs none: the fixed lines come back
         * each time, so only the last line is ever added or removed.
         * `createDynamic` builds the box as compiled JSX spreads props, and
         * is the renderer call typed to return the `JSX.Element` `Show` needs.
         */
        return createDynamic(() => "box", {
          get children() {
            return [
              ...fixed,
              ...Option.match(stats().last, {
                onNone: () => [],
                onSome: (last) => [
                  line(
                    () =>
                      `Last request ${cache.formatPercent(last.hitRate)} hit`,
                    muted,
                  ),
                ],
              }),
            ]
          },
        })
      },
      get when() {
        return Option.getOrUndefined(stats().session)
      },
    })
  },
  // The prompt cache dialog for the session `sessionID`.
  showReport = (context: Host, sessionID: string): RunResult => {
    const stats = readStats(context, sessionID)

    return context.ui.dialog.alert({
      message: [
        ...reportLines(stats.session, "Session"),
        ...reportLines(stats.last, "Last request"),
      ].join("\n"),
      title: "Prompt cache",
    })
  },
  /** The CLI plugin: the sidebar's prompt cache section and `/cache`. */
  tuiPlugin: Plugin.Definition = {
    id: "martinthommesen.oc-auth.cli",
    setup: (context: Host) => {
      context.ui.slot({
        append: "sidebar.content",
        render: (input) =>
          createComponent(section, {
            context,
            get sessionID() {
              return input.sessionID
            },
          }),
      })

      context.keymap.layer(() => ({
        commands: [
          {
            group: "Session",
            id: "oc-auth.cache",
            palette: true,
            run: (): RunResult => {
              const route = context.ui.router.current()

              if (route.type !== "session") {
                context.ui.toast.show({
                  message: "Open a session to see its prompt cache stats",
                  variant: "warning",
                })

                return Promise.resolve()
              }

              return showReport(context, route.sessionID)
            },
            slash: { name: "cache" },
            title: "Show prompt cache stats",
          },
        ],
        mode: "global",
      }))
    },
  }

export default tuiPlugin
