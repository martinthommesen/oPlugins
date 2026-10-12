import { Effect, Schema, Stream } from "effect"

/** A request to the reviewer model failed at the step `operation` names. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class RequestFailed extends Schema.TaggedError<RequestFailed>()(
  "RequestFailed",
  { cause: Schema.Defect(), model: Schema.String, operation: Schema.String },
) {
  /* Maps any failure of one request step to a `RequestFailed` that names the step. */
  public static readonly during =
    (model: string, operation: string) =>
    <Value, Failure, Requirements>(
      self: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, RequestFailed, Requirements> =>
      Effect.mapError(self, (cause) =>
        RequestFailed.make({ cause, model, operation }),
      )

  /* Maps any failure of the response stream to a `RequestFailed`. */
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
