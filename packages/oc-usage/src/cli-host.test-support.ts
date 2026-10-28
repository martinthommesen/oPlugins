import { Effect, Function as Fn, MutableRef, Schema } from "effect"
import type { Scope } from "effect"
import { testRender } from "@opentui/solid"
import type tuiPlugin from "./tui.ts"
import usageReport from "./usage-report.ts"

type Host = Parameters<typeof tuiPlugin.setup>[typeof FIRST]

type Client = ReturnType<Host["client"]["rpc"]>

type Alert = Parameters<Host["ui"]["dialog"]["alert"]>[typeof FIRST]

type Claim = Parameters<Host["ui"]["slot"]>[typeof FIRST]

type KeymapLayer = ReturnType<Parameters<Host["keymap"]["layer"]>[typeof FIRST]>

type Toast = Parameters<Host["ui"]["toast"]["show"]>[typeof FIRST]

type ReportJson = Awaited<ReturnType<Client["report"]>>

type Handler = Parameters<Client["events"]["on"]>[typeof SECOND]

type RunResult = ReturnType<KeymapLayer["commands"][number]["run"]>

type Setup = Awaited<ReturnType<typeof testRender>>

interface Collection<Value> {
  readonly append: (value: Value) => void
  readonly values: readonly Value[]
}

/** What the fake server plugin answers. */
interface Server {
  /** What each report request comes to; a failure is no answer. */
  readonly report: Effect.Effect<ReportJson, "unanswered">
  /** The saved sidebar setting. */
  readonly shown: boolean
}

/** Where the fake host records what the plugin hands it and asks of it. */
interface Recorder {
  readonly alert: (options: Alert) => void
  readonly claim: (claim: Claim) => void
  readonly layer: (layer: KeymapLayer) => void
  readonly listen: (handler: Handler) => void
  readonly reportAsked: (signal: AbortSignal) => void
  readonly saved: (shown: boolean) => void
  readonly shown: () => boolean
  readonly toast: (options: Toast) => void
  /** The plugin stopped following sidebar changes. */
  readonly unsubscribed: () => void
}

/** A fake CLI host, with a fake server plugin behind its RPC client. */
interface FakeCliHost {
  /** Every dialog the plugin showed, in order. */
  readonly alerts: readonly Alert[]
  /** Sends a sidebar change, as another CLI's save does, to the plugin while it follows them. */
  readonly announce: (shown: boolean) => void
  /** What the plugin's setup returned to undo itself. */
  readonly cleanup: () => void
  /** Every keymap layer the plugin added. */
  readonly layers: readonly KeymapLayer[]
  /** How many listeners follow sidebar changes now. */
  readonly listening: () => number
  /**
   * Mounts every claimed sidebar section until the scope closes. Succeeds
   * with a function that draws a frame and reads its lines that aren't blank.
   */
  readonly mount: Effect.Effect<
    () => Effect.Effect<readonly string[]>,
    never,
    Scope.Scope
  >
  /** The signal of every report request, in order. */
  readonly reportSignals: readonly AbortSignal[]
  /** Runs every command with the ID `id`, as the palette or the prompt would. */
  readonly run: (id: string, input?: string) => Effect.Effect<void>
  /** Every sidebar setting the plugin saved, in order. */
  readonly saved: readonly boolean[]
  /** Every toast the plugin showed, in order. */
  readonly toasts: readonly Toast[]
}

const FIRST = 0,
  /** The host's theme colors, which the renderer receives unread. */
  NO_COLOR = { intent: "default" } as const,
  SECOND = 1,
  /** The test renderer's size, in cells. */
  SIZE = { height: 12, width: 48 },
  /* Sends a sidebar change to each of `handlers`, as another CLI's save does. */
  announcing =
    (handlers: readonly Handler[]) =>
    (shown: boolean): void => {
      for (const handler of handlers) {
        handler({ data: { shown } })
      }
    },
  /* A server plugin that answers with `report` and the saved setting `shown`. */
  answering = (
    report: typeof usageReport.UsageReport.Type,
    shown: boolean,
  ): Server => ({
    report: Schema.encodeEffect(usageReport.UsageReport)(report).pipe(
      Effect.orDie,
    ),
    shown,
  }),
  /* The lines of `frame` that aren't blank, without trailing spaces. */
  asLines = (frame: string): readonly string[] =>
    frame
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== ""),
  batch = <Value>(): Collection<Value> => {
    const values: Value[] = []

    return {
      append: (value) => {
        values.push(value)
      },
      values,
    }
  },
  /* An RPC client over `server`, recording to `record`. */
  clientOver = (server: Server, record: Recorder): Client => ({
    events: {
      on: (_name, handler) => {
        record.listen(handler)

        return record.unsubscribed
      },
    },
    report: (_input, options): PromiseLike<ReportJson> => {
      record.reportAsked(options.signal)

      return Effect.runPromise(server.report, { signal: options.signal })
    },
    setSidebar: (input): PromiseLike<{ readonly shown: boolean }> => {
      record.saved(input.shown)

      return Effect.runPromise(Effect.succeed(input))
    },
    sidebar: (): PromiseLike<{ readonly shown: boolean }> =>
      Effect.runPromise(Effect.succeed({ shown: record.shown() })),
  }),
  /* A host over `server`, at no location of its own, recording to `record`. */
  hostOver = (server: Server, record: Recorder): Host => ({
    client: { rpc: () => clientOver(server, record) },
    data: {
      location: { default: () => ({ directory: "/work" }) },
      on: () => Fn.constVoid,
    },
    keymap: {
      layer: (factory) => {
        record.layer(factory())
      },
    },
    theme: { text: { base: NO_COLOR, muted: NO_COLOR } },
    ui: {
      dialog: {
        alert: (options): PromiseLike<void> => {
          record.alert(options)

          return Effect.runPromise(Effect.void)
        },
      },
      slot: (claim) => {
        record.claim(claim)

        return Fn.constVoid
      },
      toast: {
        show: (options) => {
          record.toast(options)
        },
      },
    },
  }),
  /* Mounts `claims`' sections until the scope closes. */
  mounted = Effect.fnUntraced(function* mounted(claims: readonly Claim[]) {
    const setup = yield* Effect.promise((): PromiseLike<Setup> =>
      testRender(() => claims.map((claim) => claim.render()), SIZE),
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setup.renderer.destroy()
      }),
    )

    return (): Effect.Effect<readonly string[]> =>
      Effect.promise((): PromiseLike<void> => setup.renderOnce()).pipe(
        Effect.andThen(Effect.sync(() => asLines(setup.captureCharFrame()))),
      )
  }),
  /* Runs every command among `layers` with the ID `id`, with `input`. */
  ranEach = (
    layers: readonly KeymapLayer[],
    id: string,
    input: string | undefined,
  ): Effect.Effect<void> =>
    Effect.forEach(
      layers
        .flatMap((layer) => layer.commands)
        .filter((command) => command.id === id),
      (command) =>
        Effect.promise((): PromiseLike<Awaited<RunResult>> =>
          Promise.resolve(command.run(input)),
        ),
      { discard: true },
    ),
  /* A fake CLI host over `server`, with the CLI plugin set up on it by `setUp`. */
  staged = (server: Server, setUp: (host: Host) => () => void): FakeCliHost => {
    const alerts = batch<Alert>(),
      claims = batch<Claim>(),
      handlers: Handler[] = [],
      layers = batch<KeymapLayer>(),
      reportSignals: AbortSignal[] = [],
      saved: boolean[] = [],
      stored = MutableRef.make(server.shown),
      toasts = batch<Toast>(),
      undo = setUp(
        hostOver(server, {
          alert: alerts.append,
          claim: claims.append,
          layer: layers.append,
          listen: (handler) => {
            handlers.push(handler)
          },
          reportAsked: (signal) => {
            reportSignals.push(signal)
          },
          saved: (shown) => {
            saved.push(shown)
            MutableRef.set(stored, shown)
          },
          shown: () => MutableRef.get(stored),
          toast: toasts.append,
          unsubscribed: () => {
            handlers.splice(FIRST)
          },
        }),
      )

    return {
      alerts: alerts.values,
      announce: (shown) => {
        MutableRef.set(stored, shown)
        announcing(handlers)(shown)
      },
      cleanup: undo,
      layers: layers.values,
      listening: () => handlers.length,
      mount: mounted(claims.values),
      reportSignals,
      run: (id, input) => ranEach(layers.values, id, input),
      saved,
      toasts: toasts.values,
    }
  },
  withHost = (
    server: Server,
    setUp: (host: Host) => () => void,
  ): Effect.Effect<FakeCliHost, never, Scope.Scope> =>
    Effect.acquireRelease(
      Effect.sync(() => staged(server, setUp)),
      (fake) =>
        Effect.sync(() => {
          fake.cleanup()
        }),
    )

/** A fake CLI host for the CLI plugin's tests, with an owning-scope helper. */
export default Object.freeze({ answering, make: staged, scoped: withHost })
