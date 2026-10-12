import { Effect, Function as Fn, Option } from "effect"
import type { Accessor } from "solid-js"
import type { Scope } from "effect"
import { createSignal } from "solid-js"
import { testRender } from "@opentui/solid"
import type tuiPlugin from "./tui.ts"

type Host = Parameters<typeof tuiPlugin.setup>[typeof FIRST]

type Alert = Parameters<Host["ui"]["dialog"]["alert"]>[typeof FIRST]

type Claim = Parameters<Host["ui"]["slot"]>[typeof FIRST]

type KeymapLayer = ReturnType<Parameters<Host["keymap"]["layer"]>[typeof FIRST]>

type Messages = ReturnType<Host["data"]["session"]["message"]["list"]>

type Route = ReturnType<Host["ui"]["router"]["current"]>

type RunResult = ReturnType<KeymapLayer["commands"][number]["run"]>

type Setup = Awaited<ReturnType<typeof testRender>>

type Toast = Parameters<Host["ui"]["toast"]["show"]>[typeof FIRST]

type TokenUsage = NonNullable<
  ReturnType<Host["data"]["session"]["get"]>
>["tokens"]

/** One session's data, as the fake host holds it. */
interface Session {
  readonly messages: Messages
  readonly tokens: TokenUsage
}

/** Each session's data, by its ID. */
type Sessions = ReadonlyMap<string, Session>

/** Where the fake host records what the plugin hands it. */
interface Recorder {
  readonly alert: (options: Alert) => void
  readonly claim: (claim: Claim) => void
  readonly layer: (layer: KeymapLayer) => void
  readonly toast: (options: Toast) => void
}

/**
 * A fake CLI host. Its route and session data are Solid signals, so a
 * mounted sidebar section follows them as it would the real host's.
 */
interface FakeCliHost {
  /** Every dialog the plugin showed, in order. */
  readonly alerts: Alert[]
  /** Every slot claim the plugin made. */
  readonly claims: Claim[]
  /** The host to set the plugin up on. */
  readonly host: Host
  /** Every keymap layer the plugin added. */
  readonly layers: KeymapLayer[]
  /**
   * Mount every claimed sidebar section for the session `sessionID` names.
   * Succeeds with a function that draws a frame and reads its lines that
   * aren't blank.
   */
  readonly mount: (
    sessionID: Accessor<string>,
  ) => Effect.Effect<() => Effect.Effect<readonly string[]>, never, Scope.Scope>
  /** Run every command with the ID `id`, as the palette would. */
  readonly run: (id: string) => Effect.Effect<void>
  /** Show the session `sessionID`, or the home screen when none. */
  readonly show: (sessionID: Option.Option<string>) => void
  /** Every toast the plugin showed, in order. */
  readonly toasts: Toast[]
  /** Make `session` the data of the session `sessionID`. */
  readonly update: (sessionID: string, session: Session) => void
}

const FIRST = 0,
  /** The host's theme colors, which the renderer receives unread. */
  NO_COLOR = { intent: "default" } as const,
  /** The test renderer's size, in cells. */
  SIZE = { height: 10, width: 48 },
  /* The lines of `frame` that aren't blank, without trailing spaces. */
  asLines = (frame: string): readonly string[] =>
    frame
      .split("\n")
      .map((line) => line.trimEnd())
      .filter((line) => line !== ""),
  /* What a command returned, once it settles. */
  awaited = (result: () => RunResult): Effect.Effect<void> =>
    Effect.promise((): PromiseLike<Awaited<RunResult>> =>
      Promise.resolve(result()),
    ).pipe(Effect.asVoid),
  /* A frame of `setup`'s renderer, drawn and read. */
  drawn = (setup: () => Setup): Effect.Effect<readonly string[]> =>
    Effect.promise((): PromiseLike<void> => setup().renderOnce()).pipe(
      Effect.andThen(Effect.sync(() => asLines(setup().captureCharFrame()))),
    ),
  /* A host whose state is `route` and `sessions`, recording to `record`. */
  hostOver = (
    record: Recorder,
    route: Accessor<Route>,
    sessions: Accessor<Sessions>,
  ): Host => ({
    data: {
      session: {
        get: (sessionID) => sessions().get(sessionID),
        message: {
          list: (sessionID) =>
            Option.fromUndefinedOr(sessions().get(sessionID)).pipe(
              Option.match({
                onNone: () => [],
                onSome: (session) => session.messages,
              }),
            ),
        },
      },
    },
    keymap: {
      layer: (factory) => {
        record.layer(factory())
      },
    },
    theme: { text: { base: NO_COLOR, muted: NO_COLOR } },
    ui: {
      dialog: {
        alert: (options) => {
          record.alert(options)
        },
      },
      router: { current: route },
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
  /* Mount `claims`' sections for the session `sessionID` names. */
  mounted = Effect.fnUntraced(function* mounted(
    claims: Accessor<readonly Claim[]>,
    sessionID: Accessor<string>,
  ) {
    const setup = yield* Effect.promise((): PromiseLike<Setup> =>
      testRender(
        () =>
          claims().map((claim) =>
            claim.render({
              get sessionID() {
                return sessionID()
              },
            }),
          ),
        SIZE,
      ),
    )

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        setup.renderer.destroy()
      }),
    )

    return (): Effect.Effect<readonly string[]> => drawn(() => setup)
  }),
  /* Run every command `layers` hold with the ID `id`. */
  ranEach = (
    layers: Accessor<readonly KeymapLayer[]>,
    id: string,
  ): Effect.Effect<void> =>
    Effect.forEach(
      layers()
        .flatMap((layer) => layer.commands)
        .filter((command) => command.id === id),
      (command) => awaited((): RunResult => command.run()),
      { discard: true },
    ),
  /* The route to the session `sessionID`, or to the home screen when none. */
  routeTo = (sessionID: Option.Option<string>): Route =>
    Option.match(sessionID, {
      onNone: (): Route => ({ type: "home" }),
      onSome: (id): Route => ({ sessionID: id, type: "session" }),
    }),
  /* A fake CLI host on the home screen, with no sessions. */
  staged = (): FakeCliHost => {
    const alerts: Alert[] = [],
      claims: Claim[] = [],
      layers: KeymapLayer[] = [],
      [route, setRoute] = createSignal<Route>({ type: "home" }),
      [sessions, setSessions] = createSignal<Sessions>(new Map()),
      toasts: Toast[] = []

    return {
      alerts,
      claims,
      host: hostOver(
        {
          alert: (options) => {
            alerts.push(options)
          },
          claim: (claim) => {
            claims.push(claim)
          },
          layer: (layer) => {
            layers.push(layer)
          },
          toast: (options) => {
            toasts.push(options)
          },
        },
        route,
        sessions,
      ),
      layers,
      mount: (sessionID) => mounted(() => claims, sessionID),
      run: (id) => ranEach(() => layers, id),
      show: (sessionID) => {
        setRoute(routeTo(sessionID))
      },
      toasts,
      update: (sessionID, session) => {
        setSessions(new Map([...sessions(), [sessionID, session]]))
      },
    }
  }

/** A fake CLI host for the CLI plugin's tests. */
export default Object.freeze({ make: staged })
