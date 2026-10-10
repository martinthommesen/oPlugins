import type { Plugin } from "@opencode/plugin/tui"

type Context = Plugin.Context

/** A palette command, as this plugin declares it. */
interface Command {
  readonly group: string
  readonly id: string
  readonly palette: true
  readonly run: () => void
  readonly title: string
}

/** A keymap layer, as this plugin declares it. */
interface KeymapLayer {
  readonly commands: readonly Command[]
  readonly mode: string
}

/** The parts of the TUI plugin context this plugin uses, read-only. */
interface Host {
  readonly keymap: { readonly layer: (factory: () => KeymapLayer) => void }
  readonly ui: {
    readonly toast: { readonly show: Context["ui"]["toast"]["show"] }
  }
}

/** The TUI side of oBrowse: a palette command that confirms it loaded. */
const tuiPlugin = {
  id: "martinthommesen.obrowse.tui",
  setup: (context: Host): void => {
    context.keymap.layer(() => ({
      commands: [
        {
          group: "oBrowse",
          id: "obrowse.status",
          palette: true,
          run: (): void => {
            context.ui.toast.show({
              message: "oBrowse is loaded",
              variant: "info",
            })
          },
          title: "Show oBrowse status",
        },
      ],
      mode: "global",
    }))
  },
} satisfies Plugin.Definition

export default tuiPlugin
