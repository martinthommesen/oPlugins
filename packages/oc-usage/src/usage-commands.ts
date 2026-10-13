import { Boolean as Bool, Clock, Effect } from "effect"
import type { Accessor } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import sidebarCommand from "./sidebar-command.ts"
import usageClient from "./usage-client.ts"
import usageText from "./usage-text.ts"

type Context = Plugin.Context

type Connection = Parameters<typeof usageClient.report>[typeof FIRST]

type Report = Effect.Success<ReturnType<typeof usageClient.report>>

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

/** A command this plugin adds, as it declares it. */
interface Command {
  readonly group: string
  readonly id: string
  readonly palette: true
  readonly run: (input?: string) => RunResult
  readonly slash: { readonly arguments?: true; readonly name: string }
  readonly title: string
}

/** What the commands act on. */
interface Controls {
  readonly connection: Connection
  /** Shows or hides the usage section in this CLI's sidebar. */
  readonly show: (shown: boolean) => void | Effect.Effect<void>
  /** Whether this CLI's sidebar shows the usage section. */
  readonly shown: Accessor<boolean>
  readonly ui: {
    readonly dialog: {
      readonly alert: (options: AlertOptions) => PromiseLike<void>
    }
    readonly toast: { readonly show: Context["ui"]["toast"]["show"] }
  }
}

const FIRST = 0,
  GROUP = "Usage",
  /* Shows a toast. */
  notify = (ui: Controls["ui"], toast: Toast): Effect.Effect<void> =>
    Effect.sync(() => {
      ui.toast.show(toast)
    }),
  /* Shows every subscription's usage in a dialog, or why it can't. */
  reportDialog = (controls: Controls): Effect.Effect<void> =>
    Effect.all([
      usageClient.report(controls.connection),
      Clock.currentTimeMillis,
    ]).pipe(
      Effect.flatMap(([report, now]: readonly [Report, number]) =>
        Effect.promise((): PromiseLike<void> =>
          controls.ui.dialog.alert({
            message: usageText.usageDialog(report, now),
            title: "Subscription usage",
          }),
        ),
      ),
      Effect.catchTag(
        "UsageUnavailable",
        (failure: { readonly message: string }) =>
          notify(controls.ui, { message: failure.message, variant: "error" }),
      ),
    ),
  /* Saves whether the sidebar shows the usage section, and shows what was saved. */
  saveSidebar = (controls: Controls, shown: boolean): Effect.Effect<void> =>
    usageClient.setSidebar(controls.connection, shown).pipe(
      Effect.tap((saved) =>
        Effect.suspend(() => controls.show(saved) ?? Effect.void),
      ),
      Effect.flatMap((saved) =>
        notify(controls.ui, {
          message: Bool.match(saved, {
            onFalse: () => "Usage is no longer in the sidebar.",
            onTrue: () => "Usage is in the sidebar until /show-usage off.",
          }),
          variant: "success",
        }),
      ),
      Effect.catchTag(
        "UsageUnavailable",
        (failure: { readonly message: string }) =>
          notify(controls.ui, { message: failure.message, variant: "error" }),
      ),
    ),
  /* Carries out `/show-usage` with the text after it. */
  showUsage = (controls: Controls, input: string): Effect.Effect<void> =>
    sidebarCommand.SidebarRequest.$match(sidebarCommand.parse(input), {
      Invalid: (request) =>
        notify(controls.ui, {
          message: `/show-usage takes on or off, not "${request.input}".`,
          variant: "warning",
        }),
      Set: ({ shown }) => saveSidebar(controls, shown),
      Toggle: () => saveSidebar(controls, !controls.shown()),
    }),
  /* `/usage` and `/show-usage`, which the command palette offers too. */
  usageCommands = (controls: Controls): readonly Command[] => [
    {
      group: GROUP,
      id: "oc-usage.report",
      palette: true,
      run: (): RunResult => Effect.runPromise(reportDialog(controls)),
      slash: { name: "usage" },
      title: "Show subscription usage",
    },
    {
      group: GROUP,
      id: "oc-usage.sidebar",
      palette: true,
      run: (input?: string): RunResult =>
        Effect.runPromise(showUsage(controls, input ?? "")),
      slash: { arguments: true, name: "show-usage" },
      title: "Show or hide usage in the sidebar",
    },
  ]

/** The CLI plugin's commands. */
export default Object.freeze({ usageCommands })
