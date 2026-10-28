import { Effect, Option, Schema } from "effect"
import type { Duration } from "effect"
import UsageUnavailable from "./usage-unavailable-error.ts"
import sidebarState from "./sidebar-state.ts"
import usageReport from "./usage-report.ts"
import usageTimeouts from "./usage-timeouts.ts"

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
  ) => PromiseLike<Schema.Json>
  readonly setSidebar: (
    input: Sidebar,
    options: CallOptions,
  ) => PromiseLike<Schema.Json>
  readonly sidebar: (
    input: Readonly<Record<string, never>>,
    options: CallOptions,
  ) => PromiseLike<Schema.Json>
}

/** The RPC client, and the location its calls go to. */
interface Connection {
  readonly client: UsageClient
  readonly location: CallOptions["location"]
  readonly generation?: () => number
}

const NO_INPUT = {},
  NO_REVISION = 0,
  SidebarAnswer = Schema.Struct({ shown: Schema.Boolean }),
  /* A call of the RPC, which fails with why the server plugin didn't answer. */
  called = <Value>(
    call: (signal: AbortSignal) => PromiseLike<Value>,
    operation: string,
    duration: Duration.Duration,
  ): Effect.Effect<Value, UsageUnavailable> =>
    Effect.tryPromise({
      catch: () =>
        UsageUnavailable.make({
          message: `oc-usage couldn't ${operation}. The RPC failed; the server may be unavailable or the operation may have failed. Retry, then check the OpenCode server logs and that oc-usage is in plugins in opencode.jsonc.`,
        }),
      try: call,
    }).pipe(
      Effect.timeoutOrElse({
        duration,
        orElse: () =>
          Effect.fail(
            UsageUnavailable.make({
              message: `OpenCode didn't finish ${operation} before its deadline. Retry and check the server. A visibility change may already have been saved.`,
            }),
          ),
      }),
      Effect.tapError(() =>
        Effect.logWarning("usage_rpc_failed").pipe(
          Effect.annotateLogs({ operation }),
        ),
      ),
    ),
  connectionStamp = (connection: Connection): string =>
    JSON.stringify([
      connection.location.directory,
      Option.fromUndefinedOr(connection.generation).pipe(
        Option.map((generation) => generation()),
        Option.getOrElse(() => NO_REVISION),
      ),
    ]),
  decodeReport = Schema.decodeUnknownEffect(usageReport.UsageReport),
  decodeSidebar = Schema.decodeUnknownEffect(sidebarState),
  decodeSidebarOption = Schema.decodeUnknownOption(SidebarAnswer),
  ensureCurrent = (
    connection: Connection,
    before: string,
  ): Effect.Effect<void, UsageUnavailable> => {
    if (connectionStamp(connection) !== before) {
      return Effect.fail(
        UsageUnavailable.make({
          message:
            "The location or sign-in changed during this request. Its old result was discarded; retry /usage.",
        }),
      )
    }

    return Effect.void
  },
  /* Turns an answer this version can't read into an unavailable report. */
  illegible = Effect.fnUntraced(function* unreadable() {
    yield* Effect.logWarning("usage_rpc_unreadable")

    return yield* UsageUnavailable.make({
      message:
        "oc-usage's server plugin answered in a form this CLI can't read. Restart OpenCode, so both run the same version.",
    })
  }),
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
  readVisibility = (
    answer: typeof sidebarState.Type,
  ): Effect.Effect<boolean, UsageUnavailable> =>
    Option.match(Option.fromUndefinedOr(answer.problem), {
      onNone: () => Effect.succeed(answer.shown),
      onSome: (message) => Effect.fail(UsageUnavailable.make({ message })),
    }),
  /* Every subscription's usage, from the server plugin. */
  report = (
    connection: Connection,
  ): Effect.Effect<typeof usageReport.UsageReport.Type, UsageUnavailable> =>
    Effect.suspend(() => {
      const before = connectionStamp(connection),
        { location } = connection

      return called(
        (signal) =>
          connection.client.report(NO_INPUT, {
            location,
            signal,
          }),
        "read usage",
        usageTimeouts.rpc,
      ).pipe(
        Effect.flatMap(decodeReport),
        Effect.catchTag("SchemaError", illegible),
        Effect.tap(() => ensureCurrent(connection, before)),
      )
    }),
  /* Saves whether the sidebar shows the usage section, and returns what was saved. */
  setSidebar = (
    connection: Connection,
    shown: boolean,
  ): Effect.Effect<boolean, UsageUnavailable> =>
    Effect.suspend(() => {
      const before = connectionStamp(connection),
        { location } = connection

      return called(
        (signal) =>
          connection.client.setSidebar({ shown }, { location, signal }),
        "save sidebar visibility",
        usageTimeouts.setting,
      ).pipe(
        Effect.flatMap(decodeSidebar),
        Effect.flatMap(readVisibility),
        Effect.catchTag("SchemaError", illegible),
        Effect.tap(() => ensureCurrent(connection, before)),
      )
    }),
  /* Whether the sidebar shows the usage section, as saved. */
  sidebar = (
    connection: Connection,
  ): Effect.Effect<boolean, UsageUnavailable> =>
    Effect.suspend(() => {
      const before = connectionStamp(connection),
        { location } = connection

      return called(
        (signal) =>
          connection.client.sidebar(NO_INPUT, {
            location,
            signal,
          }),
        "read sidebar visibility",
        usageTimeouts.setting,
      ).pipe(
        Effect.flatMap(decodeSidebar),
        Effect.flatMap(readVisibility),
        Effect.catchTag("SchemaError", illegible),
        Effect.tap(() => ensureCurrent(connection, before)),
      )
    })

/** The server plugin's RPC, as the CLI plugin calls it, with every answer decoded. */
export default Object.freeze({
  onSidebarChange,
  report,
  setSidebar,
  sidebar,
  stamp: connectionStamp,
})
