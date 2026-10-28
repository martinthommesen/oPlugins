import { Deferred, Effect, Function as Fn, Match, Ref } from "effect"
import type { Schema } from "effect"
import type usageClient from "./usage-client.ts"

type Connection = Parameters<typeof usageClient.report>[typeof FIRST]

type Options = Parameters<Connection["client"]["report"]>[typeof SECOND]

const FIRST = 0,
  SECOND = 1,
  answering = (answer: Schema.Json): Connection => ({
    client: {
      events: { on: () => Fn.constVoid },
      report: (): PromiseLike<Schema.Json> =>
        Effect.runPromise(Effect.succeed(answer)),
      setSidebar: ({ shown }): PromiseLike<Schema.Json> =>
        Effect.runPromise(Effect.succeed({ shown })),
      sidebar: (): PromiseLike<Schema.Json> =>
        Effect.runPromise(Effect.succeed(answer)),
    },
    location: { directory: "/work" },
  }),
  held = Effect.gen(function* holdResponse() {
    const entered = yield* Deferred.make<boolean>(),
      release = yield* Deferred.make<boolean>(),
      response = Deferred.succeed(entered, true).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as({ subscriptions: [] }),
      )

    return { entered, release, response }
  }),
  scripted = (
    response: Effect.Effect<Schema.Json>,
    controls: {
      readonly generation: Ref.Ref<number>
      readonly signals: Ref.Ref<readonly AbortSignal[]>
    },
    method: "report" | "setSidebar" | "sidebar" = "report",
  ): Connection => {
    const base = answering({}),
      request = (
        _input: Readonly<Record<string, never>> | { readonly shown: boolean },
        options: Options,
      ): PromiseLike<Schema.Json> =>
        Effect.runPromise(
          Ref.update(controls.signals, (values) => [
            ...values,
            options.signal,
          ]).pipe(Effect.andThen(response)),
          { signal: options.signal },
        )

    return {
      client: {
        events: base.client.events,
        report: Match.value(method).pipe(
          Match.when("report", () => request),
          Match.orElse(() => base.client.report),
        ),
        setSidebar: Match.value(method).pipe(
          Match.when("setSidebar", () => request),
          Match.orElse(() => base.client.setSidebar),
        ),
        sidebar: Match.value(method).pipe(
          Match.when("sidebar", () => request),
          Match.orElse(() => base.client.sidebar),
        ),
      },
      generation: () => Ref.getUnsafe(controls.generation),
      location: base.location,
    }
  }

export default Object.freeze({ answering, held, scripted })
