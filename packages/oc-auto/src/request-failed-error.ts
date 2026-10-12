import { Effect, Schema, Stream } from "effect"
import requestFailure from "./request-failure.ts"

/** A request to the reviewer model failed at the step `operation` names. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class RequestFailed extends Schema.TaggedError<RequestFailed>()(
  "RequestFailed",
  {
    /** Why the step failed, from a bounded vocabulary. */
    category: requestFailure.Category,
    /** What the step failed with. It may quote the provider or the conversation. */
    cause: Schema.Defect(),
    model: Schema.String,
    operation: Schema.String,
    /** The HTTP status the backend answered with, when there was one. */
    status: Schema.Option(Schema.Finite),
  },
) {
  /* Maps any failure of one request step to a `RequestFailed` that names the step and the failure's category. */
  public static readonly during =
    (model: string, operation: string) =>
    <Value, Failure, Requirements>(
      self: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, RequestFailed, Requirements> =>
      Effect.mapError(self, (cause) => {
        const { category, status } = requestFailure.classify(cause)

        return RequestFailed.make({ category, cause, model, operation, status })
      })

  /* Maps any failure of the response stream to a `RequestFailed` with the failure's category. */
  public static readonly whileStreaming =
    (model: string) =>
    <Value, Failure, Requirements>(
      self: Stream.Stream<Value, Failure, Requirements>,
    ): Stream.Stream<Value, RequestFailed, Requirements> =>
      Stream.mapError(self, (cause) => {
        const { category, status } = requestFailure.classify(cause)

        return RequestFailed.make({
          category,
          cause,
          model,
          operation: "stream",
          status,
        })
      })
}

export default RequestFailed
