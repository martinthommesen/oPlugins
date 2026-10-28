import {
  Effect,
  Function as Fn,
  Match,
  Option,
  Predicate,
  Struct,
  flow,
} from "effect"
import { FetchHttpClient } from "effect/http"

type Options = Readonly<Pick<RequestInit, "signal">>

type Input = Request | string | { readonly href: string }

type Arguments = readonly [Request | string, Options]

interface Ownership {
  readonly close: () => void
  readonly signal: AbortSignal
}

const acquire = Effect.sync((): Ownership => {
    const controller = new AbortController()

    return Object.freeze({
      close: () => {
        controller.abort()
      },
      signal: controller.signal,
    })
  }),
  addressOf = (input: Input): Request | string =>
    Match.value(input).pipe(
      Match.when(Predicate.isString, (text) => text),
      Match.when(Match.instanceOf(Request), (request) => request),
      Match.when({ href: Predicate.isString }, (url) => url.href),
      Match.orElse((request) => request),
    ),
  signalOf = (input: Input, options: Options): Option.Option<AbortSignal> =>
    Option.match(Option.fromUndefinedOr(options.signal), {
      onNone: () =>
        Match.value(input).pipe(
          Match.when(Match.instanceOf(Request), (request) =>
            Option.some(request.signal),
          ),
          Match.orElse(() => Option.none()),
        ),
      onSome: (signal) => Option.fromNullishOr(signal),
    }),
  withOwner = (
    transport: typeof globalThis.fetch,
    owned: AbortSignal,
  ): typeof globalThis.fetch => {
    const prepare = (input: Input, options: Options = {}): Arguments => {
        const signals = signalOf(input, options).pipe(Option.toArray),
          updated = Struct.assign(options, {
            signal: AbortSignal.any([owned, ...signals]),
          })

        return [addressOf(input), updated]
      },
      send = Fn.tupled<Arguments, ReturnType<typeof globalThis.fetch>>(
        transport,
      )

    return flow(prepare, send)
  },
  /* FetchHttpClient overwrites RequestInit.signal; delegate through its configured transport instead. */
  wrap = <Value, Failure, Requirements>(
    program: Effect.Effect<Value, Failure, Requirements>,
    transport: typeof globalThis.fetch,
  ): Effect.Effect<Value, Failure, Requirements> =>
    Effect.acquireUseRelease(
      acquire,
      (owner) => {
        const delegated = withOwner(transport, owner.signal)

        return program.pipe(
          Effect.provideService(FetchHttpClient.Fetch, delegated),
        )
      },
      (owner) =>
        Effect.sync(() => {
          owner.close()
        }),
    )

export default Object.freeze({ wrap })
