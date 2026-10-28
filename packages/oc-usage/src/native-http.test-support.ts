import {
  Context,
  Deferred,
  Effect,
  Layer,
  Option,
  Ref,
  Schema,
  flow,
} from "effect"
import { FetchHttpClient } from "effect/http"
import UsageMeter from "./usage-meter.ts"

const HTTP_OK = 200,
  NO_BUFFER = 0,
  RequestFields = Schema.Struct({
    headers: Schema.Record(Schema.String, Schema.String),
    method: Schema.String,
    redirect: Schema.String,
  }),
  /* Pull begins only once the client consumes the body; no network or module mock is involved. */
  heldBody = (ready: Deferred.Deferred<boolean>): ReadableStream<Uint8Array> =>
    new ReadableStream<Uint8Array>(
      {
        pull: (): PromiseLike<void> =>
          Effect.runPromise(Deferred.succeed(ready, true).pipe(Effect.asVoid)),
      },
      { highWaterMark: NO_BUFFER },
    )

class NativeHttp extends Context.Service<
  NativeHttp,
  {
    readonly bodyStarted: Deferred.Deferred<boolean>
    readonly forwarded: Ref.Ref<readonly (typeof RequestFields.Type)[]>
    readonly signals: Ref.Ref<readonly AbortSignal[]>
  }
>()("@martinthommesen/oc-usage/native-http.test-support/NativeHttp") {
  public static readonly layer = (
    status: number,
  ): Layer.Layer<NativeHttp | UsageMeter> =>
    Layer.effectContext(
      Effect.gen(function* build() {
        const bodyStarted = yield* Deferred.make<boolean>(),
          forwarded = yield* Ref.make<readonly (typeof RequestFields.Type)[]>(
            [],
          ),
          response = new Response(heldBody(bodyStarted), { status }),
          signals = yield* Ref.make<readonly AbortSignal[]>([]),
          transport: typeof globalThis.fetch = flow(
            (
              _input: Request | string | { readonly href: string },
              init: Readonly<Pick<RequestInit, "signal">> = {},
            ) =>
              Option.match(Option.fromNullishOr(init.signal), {
                onNone: () => Effect.void,
                onSome: (signal) =>
                  Ref.update(signals, (values) => [...values, signal]),
              }).pipe(
                Effect.andThen(Schema.decodeUnknownEffect(RequestFields)(init)),
                Effect.tap((fields) =>
                  Ref.update(forwarded, (values) => [...values, fields]),
                ),
                Effect.as(response),
              ),
            Effect.runPromise,
          ),
          transportLayer = Layer.succeed(FetchHttpClient.Fetch, transport),
          usage = yield* Layer.build(
            UsageMeter.live.pipe(Layer.provide(transportLayer)),
          )

        return Context.add(usage, NativeHttp, {
          bodyStarted,
          forwarded,
          signals,
        })
      }),
    )

  public static readonly success = NativeHttp.layer(HTTP_OK)
}

export default NativeHttp
