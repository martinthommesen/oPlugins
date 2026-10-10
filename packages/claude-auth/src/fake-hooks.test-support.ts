import { Array as Arr, Context, Effect, Layer, Option } from "effect"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type claudeAuth from "./claude-auth-plugin.ts"

type Host = Parameters<typeof claudeAuth.setUp>[typeof FIRST]

type Handler<Name extends keyof SessionHooks> = (
  input: SessionHooks[Name],
) => Effect.Effect<void, Record<keyof SessionHooks, never>[Name]>

/** The handler registered for one hook, if any. */
interface Slot<Name extends keyof SessionHooks> {
  readonly current: () => Option.Option<Handler<Name>>
  readonly set: (handler: Handler<Name>) => void
}

/*
 * One slot per hook, so a handler keeps its hook's event type: reading a
 * slot by a generic name is typed, where writing a map by one is not.
 */
type Slots = { readonly [Name in keyof SessionHooks]: Slot<Name> }

const FIRST = 0,
  /** What registering a hook hands back; disposal is the scope's job. */
  REGISTRATION = Object.freeze({ dispose: Effect.void }),
  /* An empty slot for one hook. */
  makeSlot = <Name extends keyof SessionHooks>(): Slot<Name> => {
    const handlers: Handler<Name>[] = []

    return {
      current: () => Arr.last(handlers),
      set: (handler) => {
        handlers.push(handler)
      },
    }
  },
  /* A slot for every hook the host offers. */
  makeSlots = (): Slots => ({
    compaction: makeSlot(),
    context: makeSlot(),
    "experimental.ws.handshake": makeSlot(),
    "experimental.ws.receive": makeSlot(),
    "experimental.ws.send": makeSlot(),
    generate: makeSlot(),
    "http.request": makeSlot(),
    "http.response": makeSlot(),
    "model.request": makeSlot(),
    prompt: makeSlot(),
    retry: makeSlot(),
    title: makeSlot(),
  })

/** The host's session hooks, recording what the plugin registers. */
class FakeHooks extends Context.Service<
  FakeHooks,
  {
    /** Run the hook registered under `name` with `event`. */
    readonly fire: <Name extends keyof SessionHooks>(
      name: Name,
      event: SessionHooks[Name],
    ) => Effect.Effect<void>
    /** The hook API the plugin is given. */
    readonly hook: Host["session"]["hook"]
    /** The names registered, in order. */
    readonly names: Effect.Effect<readonly string[]>
    /** The options each registration passed, as JSON, in order. */
    readonly options: Effect.Effect<readonly string[]>
  }
>()("oclaude/test/FakeHooks") {
  /** Hooks recorded for one test. */
  public static readonly layer: Layer.Layer<FakeHooks> = Layer.sync(
    FakeHooks,
    () => {
      const order: string[] = [],
        passed: string[] = [],
        slots = makeSlots()

      return FakeHooks.of({
        fire: (name, event) =>
          Option.match(slots[name].current(), {
            onNone: () => Effect.die(`no ${name} hook was registered`),
            onSome: (handler) => handler(event),
          }),
        hook: (name, handler, options) =>
          Effect.sync(() => {
            slots[name].set(handler)
            order.push(name)
            passed.push(JSON.stringify(options))

            return REGISTRATION
          }),
        names: Effect.sync(() => [...order]),
        options: Effect.sync(() => [...passed]),
      })
    },
  )
}

export default FakeHooks
