import { Context, Effect, Layer, Option, Queue, Ref, Stream } from "effect"
import type claudeAuth from "./claude-auth-plugin.ts"

type Host = Parameters<typeof claudeAuth.setUp>[typeof FIRST]

/** An event the fake host emits. */
interface HostEvent {
  readonly data: {
    readonly credentialID: string
    readonly integrationID: string
  }
  readonly type: string
}

const FIRST = 0,
  ONE = 1

/** The host's event stream, one queue per subscription. */
class FakeEvents extends Context.Service<
  FakeEvents,
  {
    /** How many subscriptions have finished, by ending or by interruption. */
    readonly closed: Effect.Effect<number>
    /** Fail the current subscription, as a dropped host stream would. */
    readonly drop: Effect.Effect<void>
    /** The event API the plugin is given. */
    readonly subscribe: Host["event"]["subscribe"]
    /** How many times the plugin subscribed. */
    readonly subscriptions: Effect.Effect<number>
    /** Emit a switch of the Anthropic credential to `credentialID`. */
    readonly switchTo: (credentialID: string) => Effect.Effect<void>
  }
>()("oclaude/test/FakeEvents") {
  /** Events for one test. */
  public static readonly layer: Layer.Layer<FakeEvents> = Layer.effect(
    FakeEvents,
    Effect.gen(function* makeEvents() {
      const count = yield* Ref.make(FIRST),
        current = yield* Ref.make(
          Option.none<Queue.Queue<HostEvent, string>>(),
        ),
        ended = yield* Ref.make(FIRST),
        withCurrent = (
          use: (
            queue: Queue.Queue<HostEvent, string>,
          ) => Effect.Effect<boolean>,
        ): Effect.Effect<void> =>
          Ref.get(current).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.succeed(false),
                onSome: use,
              }),
            ),
            Effect.asVoid,
          )

      return FakeEvents.of({
        closed: Ref.get(ended),
        drop: withCurrent((queue) => Queue.fail(queue, "stream dropped")),
        subscribe: () =>
          Stream.unwrap(
            Queue.unbounded<HostEvent, string>().pipe(
              Effect.tap((queue) => Ref.set(current, Option.some(queue))),
              Effect.tap(() => Ref.update(count, (total) => total + ONE)),
              Effect.map((queue) =>
                Stream.fromQueue(queue).pipe(
                  Stream.ensuring(Ref.update(ended, (total) => total + ONE)),
                ),
              ),
            ),
          ),
        subscriptions: Ref.get(count),
        switchTo: (credentialID) =>
          withCurrent((queue) =>
            Queue.offer(queue, {
              data: { credentialID, integrationID: "anthropic" },
              type: "credential.switched",
            }),
          ),
      })
    }),
  )
}

export default FakeEvents
