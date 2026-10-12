import type { Plugin } from "@opencode/plugin/tui"

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

/** The parts of the CLI plugin context this plugin uses, read-only. */
interface Host {
  readonly keymap: { readonly layer: (factory: () => KeymapLayer) => void }
  readonly ui: {
    readonly toast: { readonly show: Plugin.Context["ui"]["toast"]["show"] }
  }
}

/** The CLI plugin: a palette command that confirms oc-browser loaded. */
const tuiPlugin = {
  id: "martinthommesen.oc-browser.cli",
  setup: (context: Host): void => {
    context.keymap.layer(() => ({
      commands: [
        {
          group: "oc-browser",
          id: "oc-browser.status",
          palette: true,
          run: (): void => {
            context.ui.toast.show({
              message: "oc-browser is loaded",
              variant: "info",
            })
          },
          title: "Show oc-browser status",
        },
      ],
      mode: "global",
    }))
  },
} satisfies Plugin.Definition

export default tuiPlugin
