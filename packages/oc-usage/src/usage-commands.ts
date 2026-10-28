import { Boolean as Bool, Clock, Effect } from "effect"
import type { Plugin } from "@opencode/plugin/tui"
import type UsageUnavailable from "./usage-unavailable-error.ts"
import sidebarCommand from "./sidebar-command.ts"
import usageClient from "./usage-client.ts"
import usageText from "./usage-text.ts"

type Context = Plugin.Context

type Connection = Parameters<typeof usageClient.report>[typeof FIRST]

type HostKeymapLayer = Context["keymap"]["layer"] extends (
  factory: () => infer Layer,
) => void
  ? Layer
  : never

type RunResult = ReturnType<
  NonNullable<HostKeymapLayer["commands"]>[number]["run"]
>

type AlertOptions = Parameters<Context["ui"]["dialog"]["alert"]>[typeof FIRST]

type Toast = Parameters<Context["ui"]["toast"]["show"]>[typeof FIRST]

interface Command {
  readonly group: string
  readonly id: string
  readonly palette: true
  readonly run: (input?: string) => RunResult
  readonly slash: { readonly arguments?: true; readonly name: string }
  readonly title: string
}

interface Controls {
  readonly connection: Connection
  readonly reconcile: Effect.Effect<void, UsageUnavailable>
  readonly run: (program: Effect.Effect<unknown>) => RunResult
  readonly shown: () => boolean
  readonly ui: {
    readonly dialog: {
      readonly alert: (options: AlertOptions) => PromiseLike<void>
    }
    readonly toast: { readonly show: Context["ui"]["toast"]["show"] }
  }
}

interface Invocation {
  readonly controls: Controls
  readonly stamp: string
}

const FIRST = 0,
  GROUP = "Usage",
  current = (call: Invocation): boolean =>
    usageClient.stamp(call.controls.connection) === call.stamp,
  invocationOf = (controls: Controls): Invocation => ({
    controls,
    stamp: usageClient.stamp(controls.connection),
  }),
  notify = (call: Invocation, toast: Toast): Effect.Effect<void> =>
    Effect.sync(() => {
      if (current(call)) {
        call.controls.ui.toast.show(toast)
      }
    }),
  reconciledToast = (call: Invocation, saved: boolean): Effect.Effect<void> =>
    Effect.sync(() => {
      if (!current(call)) {
        return
      }

      const shown = call.controls.shown()

      if (shown !== saved) {
        call.controls.ui.toast.show({
          message: Bool.match(shown, {
            onFalse: () =>
              "Usage visibility changed while confirming the save. This window is currently hiding usage.",
            onTrue: () =>
              "Usage visibility changed while confirming the save. This window is currently showing usage.",
          }),
          variant: "warning",
        })

        return
      }

      call.controls.ui.toast.show({
        message: Bool.match(shown, {
          onFalse: () => "Usage is no longer in the sidebar.",
          onTrue: () => "Usage is in the sidebar until /show-usage off.",
        }),
        variant: "success",
      })
    }),
  reportDialog = (controls: Controls): Effect.Effect<void> =>
    Effect.suspend(() => {
      const call = invocationOf(controls)

      return usageClient.report(controls.connection).pipe(
        Effect.flatMap((report) =>
          Clock.currentTimeMillis.pipe(
            Effect.flatMap((now) =>
              Effect.suspend(() => {
                if (!current(call)) {
                  return Effect.void
                }

                return Effect.promise((): PromiseLike<void> =>
                  controls.ui.dialog.alert({
                    message: usageText.usageDialog(report, now),
                    title: "Subscription usage",
                  }),
                )
              }),
            ),
          ),
        ),
        Effect.catchTag(
          "UsageUnavailable",
          (failure: { readonly message: string }) =>
            notify(call, { message: failure.message, variant: "error" }),
        ),
      )
    }),
  saveSidebar = (call: Invocation, shown: boolean): Effect.Effect<void> =>
    Effect.suspend(() => {
      if (!current(call)) {
        return Effect.void
      }

      return usageClient.setSidebar(call.controls.connection, shown).pipe(
        Effect.tap(() =>
          Effect.suspend(() => {
            if (!current(call)) {
              return Effect.void
            }

            return call.controls.reconcile
          }),
        ),
        Effect.flatMap((saved) => reconciledToast(call, saved)),
        Effect.catchTag(
          "UsageUnavailable",
          (failure: { readonly message: string }) =>
            notify(call, { message: failure.message, variant: "error" }),
        ),
      )
    }),
  showUsage = (call: Invocation, input: string): Effect.Effect<void> =>
    sidebarCommand.SidebarRequest.$match(sidebarCommand.parse(input), {
      Invalid: (request) =>
        notify(call, {
          message: `/show-usage takes on or off, not "${request.input}".`,
          variant: "warning",
        }),
      Set: ({ shown }) => saveSidebar(call, shown),
      Toggle: () =>
        usageClient.sidebar(call.controls.connection).pipe(
          Effect.flatMap((shown) => saveSidebar(call, !shown)),
          Effect.catchTag(
            "UsageUnavailable",
            (failure: { readonly message: string }) =>
              notify(call, { message: failure.message, variant: "error" }),
          ),
        ),
    }),
  usageCommands = (controls: Controls): readonly Command[] => [
    {
      group: GROUP,
      id: "oc-usage.report",
      palette: true,
      run: (): RunResult => controls.run(reportDialog(controls)),
      slash: { name: "usage" },
      title: "Show subscription usage",
    },
    {
      group: GROUP,
      id: "oc-usage.sidebar",
      palette: true,
      run: (input?: string): RunResult =>
        controls.run(
          Effect.suspend(() => showUsage(invocationOf(controls), input ?? "")),
        ),
      slash: { arguments: true, name: "show-usage" },
      title: "Show or hide usage in the sidebar",
    },
  ]

export default Object.freeze({ usageCommands })
