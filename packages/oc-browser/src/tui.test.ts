import { describe, expect, it } from "@effect/vitest"
import tuiPlugin from "./tui.ts"

type Host = Parameters<typeof tuiPlugin.setup>[typeof FIRST]

type KeymapLayer = ReturnType<Parameters<Host["keymap"]["layer"]>[typeof FIRST]>

type Toast = Parameters<Host["ui"]["toast"]["show"]>[typeof FIRST]

/** What the TUI plugin registered with a fake host. */
interface Registered {
  readonly layers: KeymapLayer[]
  readonly toasts: Toast[]
}

const FIRST = 0,
  /* Set the TUI plugin up on a fake host that records what it is given. */
  setUpOnFake = (): Registered => {
    const registered: Registered = { layers: [], toasts: [] }

    tuiPlugin.setup({
      keymap: {
        layer: (factory) => {
          registered.layers.push(factory())
        },
      },
      ui: {
        toast: {
          show: (options) => {
            registered.toasts.push(options)
          },
        },
      },
    })

    return registered
  }

describe("the TUI plugin", () => {
  it(
    "adds a palette command that confirms oBrowse loaded",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const added = setUpOnFake(),
        commands = added.layers.flatMap((layer) => layer.commands)

      for (const command of commands) {
        command.run()
      }

      expect(tuiPlugin.id).toBe("martinthommesen.obrowse.tui")
      expect(added.layers).toMatchObject([
        { commands: [{ id: "obrowse.status", palette: true }], mode: "global" },
      ])
      expect(added.toasts).toStrictEqual([
        { message: "oBrowse is loaded", variant: "info" },
      ])
    },
  )
})
