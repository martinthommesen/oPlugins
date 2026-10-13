import { Effect, Option, Schema } from "effect"
import UsageUnavailable from "./usage-unavailable-error.ts"
import usageReport from "./usage-report.ts"

type ReportJson = typeof usageReport.UsageReport.Encoded

/** Whether the sidebar shows the usage section, as the RPC carries it. */
interface Sidebar {
  readonly shown: boolean
}

/** Where one RPC call goes, and what cancels it. */
interface CallOptions {
  readonly location: { readonly directory: string }
  readonly signal: AbortSignal
}

/** The oc-usage RPC, as the CLI plugin calls it. */
interface UsageClient {
  readonly events: {
    /** Calls `handler` with each change of the sidebar setting, until the returned function is called. */
    readonly on: (
      name: "sidebarChanged",
      handler: (event: { readonly data: Sidebar }) => void,
    ) => () => void
  }
  readonly report: (
    input: Readonly<Record<string, never>>,
    options: CallOptions,
  ) => PromiseLike<ReportJson>
  readonly setSidebar: (
    input: Sidebar,
    options: CallOptions,
  ) => PromiseLike<Sidebar>
  readonly sidebar: (
    input: Readonly<Record<string, never>>,
    options: CallOptions,
  ) => PromiseLike<Sidebar>
}

/** The RPC client, and the location its calls go to. */
interface Connection {
  readonly client: UsageClient
  readonly location: CallOptions["location"]
}

const NO_INPUT = {},
  SidebarAnswer = Schema.Struct({ shown: Schema.Boolean }),
  /* A call of the RPC, which fails with why the server plugin didn't answer. */
  called = <Value>(
    call: (signal: AbortSignal) => PromiseLike<Value>,
    operation: string,
  ): Effect.Effect<Value, UsageUnavailable> =>
    Effect.tryPromise({
      catch: () =>
        UsageUnavailable.make({
          message: `oc-usage couldn't ${operation}. The RPC failed; the server may be unavailable or the operation may have failed. Retry, then check the OpenCode server logs and that oc-usage is in plugins in opencode.jsonc.`,
        }),
      try: call,
    }).pipe(
      Effect.tapError(() =>
        Effect.logWarning("usage_rpc_failed").pipe(
          Effect.annotateLogs({ operation }),
        ),
      ),
    ),
  decodeReport = Schema.decodeEffect(usageReport.UsageReport),
  decodeSidebar = Schema.decodeUnknownEffect(SidebarAnswer),
  decodeSidebarOption = Schema.decodeUnknownOption(SidebarAnswer),
  /* Turns an answer this version can't read into an unavailable report. */
  illegible = (): Effect.Effect<never, UsageUnavailable> =>
    Effect.fail(
      UsageUnavailable.make({
        message:
          "oc-usage's server plugin answered in a form this CLI can't read. Restart OpenCode, so both run the same version.",
      }),
    ),
  /* Calls `apply` with each change of the sidebar setting; the returned function stops it. */
  onSidebarChange = (
    connection: Connection,
    apply: (shown: boolean) => void,
  ): (() => void) =>
    connection.client.events.on("sidebarChanged", (event) => {
      const decoded = decodeSidebarOption(event.data)

      if (Option.isSome(decoded)) {
        apply(decoded.value.shown)
      } else {
        Effect.runFork(Effect.logWarning("usage_sidebar_event_unreadable"))
      }
    }),
  /* Every subscription's usage, from the server plugin. */
  report = (
    connection: Connection,
  ): Effect.Effect<typeof usageReport.UsageReport.Type, UsageUnavailable> =>
    called(
      (signal) =>
        connection.client.report(NO_INPUT, {
          location: connection.location,
          signal,
        }),
      "read usage",
    ).pipe(
      Effect.flatMap(decodeReport),
      Effect.catchTag("SchemaError", illegible),
    ),
  /* Saves whether the sidebar shows the usage section, and returns what was saved. */
  setSidebar = (
    connection: Connection,
    shown: boolean,
  ): Effect.Effect<boolean, UsageUnavailable> =>
    called(
      (signal) =>
        connection.client.setSidebar(
          { shown },
          { location: connection.location, signal },
        ),
      "save sidebar visibility",
    ).pipe(
      Effect.flatMap(decodeSidebar),
      Effect.map((sidebar) => sidebar.shown),
      Effect.catchTag("SchemaError", illegible),
    ),
  /* Whether the sidebar shows the usage section, as saved. */
  sidebar = (
    connection: Connection,
  ): Effect.Effect<boolean, UsageUnavailable> =>
    called(
      (signal) =>
        connection.client.sidebar(NO_INPUT, {
          location: connection.location,
          signal,
        }),
      "read sidebar visibility",
    ).pipe(
      Effect.flatMap(decodeSidebar),
      Effect.map((answer) => answer.shown),
      Effect.catchTag("SchemaError", illegible),
    )

/** The server plugin's RPC, as the CLI plugin calls it, with every answer decoded. */
export default Object.freeze({ onSidebarChange, report, setSidebar, sidebar })
