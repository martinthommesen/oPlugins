import type { Plugin } from "@opencode/plugin/tui"
import {
  createElement,
  createTextNode,
  effect,
  insert,
  insertNode,
  setProp,
  type Node,
} from "@opentui/solid"
import { createComponent, createMemo, Show } from "solid-js"
import {
  cacheStats,
  formatBreakdown,
  formatPercent,
  formatRates,
  lastRequestStats,
  type CacheStats,
} from "./cache-stats.ts"

type Context = Plugin.Context

// This module is plain TypeScript rather than JSX, so it builds with `tsc`
// alone. Each helper is what Solid's JSX compiler emits for the matching
// element, and the host's OpenTUI renderer supplies the functions.
function text(
  content: string | (() => string),
  color: () => unknown,
  bold = false,
): Node {
  const node = createElement("text")
  const target = bold ? createElement("b") : node
  if (bold) insertNode(node, target)
  if (typeof content === "string") {
    insertNode(target, createTextNode(content))
  } else {
    insert(target, content)
  }
  effect((prev?: unknown) => setProp(node, "fg", color(), prev))
  return node
}

function sessionStats(context: Context, sessionID: string) {
  return {
    session: cacheStats(context.data.session.get(sessionID)?.tokens),
    last: lastRequestStats(context.data.session.message.list(sessionID)),
  }
}

function CacheSection(props: { context: Context; sessionID: string }) {
  const { context } = props
  const stats = createMemo(() => sessionStats(context, props.sessionID))
  const session = () => stats().session
  const muted = () => context.theme.text.muted
  return createComponent(Show, {
    get when() {
      return session()
    },
    get children() {
      const box = createElement("box")
      insertNode(
        box,
        text("Cache", () => context.theme.text.base, true),
      )
      insertNode(
        box,
        text(() => formatRates(session() as CacheStats), muted),
      )
      insertNode(
        box,
        text(() => formatBreakdown(session() as CacheStats), muted),
      )
      // A null marker appends. Without one, insert replaces every child.
      insert(
        box,
        () => {
          const last = stats().last
          return last
            ? text(`Last request ${formatPercent(last.hitRate)} hit`, muted)
            : null
        },
        null,
      )
      return box
    },
  })
}

function describe(stats: CacheStats | undefined, label: string): string[] {
  if (!stats) return [`${label}: no prompt tokens yet`]
  return [`${label}: ${formatRates(stats)}`, `  ${formatBreakdown(stats)}`]
}

const plugin: Plugin.Definition = {
  id: "griffinmartin.claude-auth.cache",
  setup(context) {
    context.ui.slot({
      append: "sidebar.content",
      render: (input) =>
        createComponent(CacheSection, {
          context,
          get sessionID() {
            return input.sessionID
          },
        }),
    })

    context.keymap.layer(() => ({
      mode: "global",
      commands: [
        {
          id: "claude-auth.cache",
          title: "Show prompt cache stats",
          group: "Session",
          palette: true,
          slash: { name: "cache" },
          run: async () => {
            const route = context.ui.router.current()
            if (route.type !== "session") {
              context.ui.toast.show({
                message: "Open a session to see its prompt cache stats",
                variant: "warning",
              })
              return
            }
            const { session, last } = sessionStats(context, route.sessionID)
            await context.ui.dialog.alert({
              title: "Prompt cache",
              message: [
                ...describe(session, "Session"),
                ...describe(last, "Last request"),
              ].join("\n"),
            })
          },
        },
      ],
    }))
  },
}

export default plugin
