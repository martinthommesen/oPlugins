import type { Accessor, JSX } from "solid-js"
import { Show, createComponent, createSignal } from "solid-js"
import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/tui"
import UsageRpc from "./usage-rpc.ts"
import sidebarWatch from "./sidebar-sync.ts"
import usageClient from "./usage-client.ts"
import usageCommands from "./usage-commands.ts"
import usageSidebar from "./usage-sidebar.ts"

type Connection = Parameters<typeof usageClient.report>[typeof FIRST]

type Controls = Parameters<typeof usageCommands.usageCommands>[typeof FIRST]

type Command = ReturnType<typeof usageCommands.usageCommands>[number]

type Theme = Parameters<typeof usageSidebar.section>[typeof FIRST]["theme"]

/** The host's RPC client factory, as this plugin calls it for `Definition`. */
type RpcFactory<Definition> = (definition: Definition) => Connection["client"]

/** A location the RPC can be called at. */
interface Location {
  readonly directory: string
}

/** A keymap layer, as this plugin declares it. */
interface KeymapLayer {
  readonly commands: readonly Command[]
  readonly mode: string
}

/** The sidebar section's claim on the slot tree. */
interface SidebarClaim {
  readonly append: "sidebar.content"
  readonly render: () => JSX.Element
}

/** The parts of the CLI plugin context this plugin uses, read-only. */
interface Host {
  readonly client: {
    readonly rpc: RpcFactory<typeof UsageRpc>
  }
  readonly data: {
    readonly location: { readonly default: () => Location }
  }
  readonly keymap: { readonly layer: (factory: () => KeymapLayer) => void }
  readonly location?: Location | undefined
  readonly theme: Theme
  readonly ui: Controls["ui"] & {
    readonly slot: (claim: SidebarClaim) => () => void
  }
}

const FIRST = 0,
  cleanup =
    (actions: readonly (() => void)[]): (() => void) =>
    () => {
      for (const action of actions) {
        action()
      }
    },
  /* The RPC client, calling the location the CLI opened. */
  connectionOf = (context: Host): Connection => ({
    client: context.client.rpc(UsageRpc),
    location: {
      directory: (context.location ?? context.data.location.default())
        .directory,
    },
  }),
  renderSection = (
    connection: Connection,
    theme: Theme,
    shown: Accessor<boolean>,
  ): JSX.Element =>
    createComponent<{
      readonly children: () => JSX.Element
      readonly when: boolean
    }>(Show, {
      children: () =>
        createComponent(usageSidebar.section, {
          fetch: usageClient.report(connection),
          theme,
        }),
      get when() {
        return shown()
      },
    }),
  /** The CLI plugin: `/usage`, `/show-usage`, and the sidebar's usage section. */
  tuiPlugin = {
    id: "martinthommesen.oc-usage.cli",
    setup: (context: Host): (() => void) => {
      const connection = connectionOf(context),
        [shown, setShown] = createSignal(false),
        sync = sidebarWatch.start({
          apply: (value) => {
            setShown(value)
          },
          connection,
          warn: (message) => {
            context.ui.toast.show({ message, variant: "warning" })
          },
        }),
        unlisten = usageClient.onSidebarChange(connection, () => {
          Effect.runFork(sync.refresh)
        }),
        unmount = context.ui.slot({
          append: "sidebar.content",
          render: () => renderSection(connection, context.theme, shown),
        })

      context.keymap.layer(() => ({
        commands: usageCommands.usageCommands({
          connection,
          show: () => sync.refresh,
          shown,
          ui: context.ui,
        }),
        mode: "global",
      }))

      return cleanup([
        unlisten,
        sync.close,
        () => {
          setShown(false)
        },
        unmount,
      ])
    },
  } satisfies Plugin.Definition

export default tuiPlugin
