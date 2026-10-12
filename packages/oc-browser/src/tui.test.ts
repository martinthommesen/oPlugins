import { describe, expect, it } from "@effect/vitest"
import tuiPlugin from "./tui.ts"

type Host = Parameters<typeof tuiPlugin.setup>[typeof FIRST]

type KeymapLayer = ReturnType<Parameters<Host["keymap"]["layer"]>[typeof FIRST]>

type Toast = Parameters<Host["ui"]["toast"]["show"]>[typeof FIRST]

/** What the CLI plugin registered with a fake host. */
interface Registered {
  readonly layers: KeymapLayer[]
  readonly toasts: Toast[]
}

const FIRST = 0,
  /* Sets the CLI plugin up on a fake host that records what it's given. */
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

describe("the CLI plugin", () => {
  it(
    "adds a palette command that confirms oc-browser loaded",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const added = setUpOnFake(),
        commands = added.layers.flatMap((layer) => layer.commands)

      for (const command of commands) {
        command.run()
      }

      expect(tuiPlugin.id).toBe("martinthommesen.oc-browser.cli")
      expect(added.layers).toMatchObject([
        {
          commands: [{ id: "oc-browser.status", palette: true }],
          mode: "global",
        },
      ])
      expect(added.toasts).toStrictEqual([
        { message: "oc-browser is loaded", variant: "info" },
      ])
    },
  )
})
