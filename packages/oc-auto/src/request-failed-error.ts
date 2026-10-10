import { Effect, Schema, Stream } from "effect"

/** A reviewer request failed in transport, status, or stream decoding. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class RequestFailed extends Schema.TaggedError<RequestFailed>()(
  "RequestFailed",
  { cause: Schema.Defect(), model: Schema.String, operation: Schema.String },
) {
  /* A pipeline step that maps any failure of one request step to `RequestFailed`. */
  public static readonly during =
    (model: string, operation: string) =>
    <Value, Failure, Requirements>(
      self: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, RequestFailed, Requirements> =>
      Effect.mapError(self, (cause) =>
        RequestFailed.make({ cause, model, operation }),
      )

  /* A pipeline step that maps any failure of the response stream to `RequestFailed`. */
  public static readonly whileStreaming =
    (model: string) =>
    <Value, Failure, Requirements>(
      self: Stream.Stream<Value, Failure, Requirements>,
    ): Stream.Stream<Value, RequestFailed, Requirements> =>
      Stream.mapError(self, (cause) =>
        RequestFailed.make({ cause, model, operation: "stream" }),
      )
}

export default RequestFailed
