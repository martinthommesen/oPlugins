import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import type { Schema } from "effect"
import UsageRpc from "./usage-rpc.ts"
import cliHost from "./cli-host.test-support.ts"
import { createSignal } from "solid-js"
import tuiPlugin from "./tui.ts"

type Host = Parameters<typeof tuiPlugin.setup>[typeof FIRST]

type Client = ReturnType<Host["client"]["rpc"]>

const FIRST = 0

describe("command location", () => {
  it.live(
    "routes calls to the selected session's directory rather than the setup directory",
    () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const [directory, setDirectory] = createSignal("/a"),
          requested: string[] = [],
          subject = yield* cliHost.scoped(
            { report: Effect.succeed({ subscriptions: [] }), shown: false },
            (host) => {
              const base = host.client.rpc(UsageRpc),
                tracked: Client = {
                  events: base.events,
                  report: (input, options): PromiseLike<Schema.Json> => {
                    requested.push(options.location.directory)

                    return base.report(input, options)
                  },
                  setSidebar: base.setSidebar,
                  sidebar: base.sidebar,
                }

              return tuiPlugin.setup({
                client: { rpc: () => tracked },
                data: host.data,
                keymap: host.keymap,
                get location() {
                  return { directory: directory() }
                },
                theme: host.theme,
                ui: host.ui,
              })
            },
          )

        yield* subject.run("oc-usage.report")
        setDirectory("/b")
        yield* subject.run("oc-usage.report")
        expect(requested).toStrictEqual(["/a", "/b"])
      }).pipe(Effect.scoped),
  )
})
