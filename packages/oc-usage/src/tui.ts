import type { Accessor, JSX } from "solid-js"
import {
  Show,
  createComponent,
  createEffect,
  createRoot,
  createSignal,
} from "solid-js"
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

type Watch = ReturnType<typeof sidebarWatch.start>

type RpcFactory<Definition> = (definition: Definition) => Connection["client"]

interface Location {
  readonly directory: string
}

interface KeymapLayer {
  readonly commands: readonly Command[]
  readonly mode: string
}

interface SidebarClaim {
  readonly append: "sidebar.content"
  readonly render: () => JSX.Element
}

interface Host {
  readonly client: {
    readonly rpc: RpcFactory<typeof UsageRpc>
  }
  readonly data: {
    readonly location: { readonly default: () => Location }
    readonly on: (
      name: "credential.updated" | "credential.switched",
      listener: () => void,
    ) => () => void
  }
  readonly keymap: { readonly layer: (factory: () => KeymapLayer) => void }
  readonly location?: Location | undefined
  readonly theme: Theme
  readonly ui: Controls["ui"] & {
    readonly slot: (claim: SidebarClaim) => () => void
  }
}

interface ViewControls {
  readonly connection: Connection
  readonly shown: Accessor<boolean>
  readonly sync: Watch
  readonly theme: Theme
}

const FIRST = 0,
  NEXT = 1,
  cleanup =
    (actions: readonly (() => void)[]): (() => void) =>
    () => {
      for (const action of actions) {
        action()
      }
    },
  /* The SDK's location getter changes when a session in another directory is selected. */
  connectionOf = (context: Host, generation: Accessor<number>): Connection => ({
    client: context.client.rpc(UsageRpc),
    generation,
    get location() {
      return {
        directory: (context.location ?? context.data.location.default())
          .directory,
      }
    },
  }),
  followDirectory = (connection: Connection, changed: () => void): void => {
    const [directory, setDirectory] = createSignal(
      connection.location.directory,
    )

    createEffect(() => {
      const current = connection.location.directory

      if (current !== directory()) {
        setDirectory(current)
        changed()
      }
    })
  },
  observeSidebar = (
    context: Host,
    connection: Connection,
    apply: (shown: boolean) => void,
  ): Watch =>
    sidebarWatch.start({
      apply,
      connection,
      warn: (message) => {
        context.ui.toast.show({ message, variant: "warning" })
      },
    }),
  registerCommands = (
    context: Host,
    view: Pick<ViewControls, "connection" | "shown" | "sync">,
  ): void => {
    context.keymap.layer(() => ({
      commands: usageCommands.usageCommands({
        connection: view.connection,
        reconcile: view.sync.refresh,
        run: view.sync.run,
        shown: view.shown,
        ui: context.ui,
      }),
      mode: "global",
    }))
  },
  renderSection = (view: ViewControls): JSX.Element =>
    createComponent<{
      readonly children: () => JSX.Element
      readonly when: boolean
    }>(Show, {
      children: () =>
        createComponent(usageSidebar.section, {
          fetch: usageClient.report(view.connection),
          launch: view.sync.launch,
          stamp: () => usageClient.stamp(view.connection),
          theme: view.theme,
        }),
      get when() {
        return view.shown()
      },
    }),
  setUp = (context: Host, dispose: () => void): (() => void) => {
    const [generation, setGeneration] = createSignal(FIRST),
      increment = (): void => {
        setGeneration((value) => value + NEXT)
      },
      liveConnection = connectionOf(context, generation),
      [shown, setShown] = createSignal(false),
      sync = observeSidebar(context, liveConnection, (value) => {
        setShown(value)
      }),
      uncredentials = [
        context.data.on("credential.updated", increment),
        context.data.on("credential.switched", increment),
      ],
      unlisten = usageClient.onSidebarChange(liveConnection, () => {
        sync.launch(sync.follow)
      }),
      unmount = context.ui.slot({
        append: "sidebar.content",
        render: () =>
          renderSection({
            connection: liveConnection,
            shown,
            sync,
            theme: context.theme,
          }),
      })

    followDirectory(liveConnection, () => {
      increment()
      sync.launch(sync.follow)
    })
    registerCommands(context, { connection: liveConnection, shown, sync })

    return cleanup([
      ...uncredentials,
      unlisten,
      sync.close,
      () => {
        setShown(false)
      },
      unmount,
      dispose,
    ])
  },
  tuiPlugin = {
    id: "martinthommesen.oc-usage.cli",
    setup: (context: Host): (() => void) =>
      createRoot((dispose) => setUp(context, dispose)),
  } satisfies Plugin.Definition

export default tuiPlugin
