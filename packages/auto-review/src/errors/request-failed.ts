import { Effect, Schema, Stream } from "effect"

/** A reviewer request failed in transport, status, or stream decoding. */
class RequestFailed extends Schema.TaggedError<RequestFailed>()(
  "RequestFailed",
  { cause: Schema.Defect(), model: Schema.String, operation: Schema.String },
) {}

/**
 * Maps any failure of one request step to `RequestFailed`.
 * @param {string} model The requested model.
 * @param {string} operation The step.
 * @returns {Function} A pipeline step that replaces the error.
 */
const requestFailed =
  (model: string, operation: string) =>
  <Value, Failure, Requirements>(
    self: Effect.Effect<Value, Failure, Requirements>,
  ): Effect.Effect<Value, RequestFailed, Requirements> =>
    Effect.mapError(
      self,
      (cause) => new RequestFailed({ cause, model, operation }),
    )

/**
 * Maps any failure of the response stream to `RequestFailed`.
 * @param {string} model The requested model.
 * @returns {Function} A pipeline step that replaces the stream's error.
 */
const streamFailed =
  (model: string) =>
  <Value, Failure, Requirements>(
    self: Stream.Stream<Value, Failure, Requirements>,
  ): Stream.Stream<Value, RequestFailed, Requirements> =>
    Stream.mapError(
      self,
      (cause) => new RequestFailed({ cause, model, operation: "stream" }),
    )

export { RequestFailed, requestFailed, streamFailed }
