import { Effect, Match, Option, Schema, Stream } from "effect"
import { RequestFailed, streamFailed } from "./errors/request-failed.ts"
import type { HttpClientResponse } from "effect/unstable/http"
import { Sse } from "effect/unstable/encoding"

const ResponseError = Schema.Struct({
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.String),
})

const FailedResponse = Schema.Struct({
  error: Schema.optionalKey(Schema.NullOr(ResponseError)),
})

/** The fields of a Responses stream event the client reads. */
const StreamEvent = Schema.Struct({
  delta: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(FailedResponse),
  type: Schema.String,
})

interface StreamEvent extends Schema.Schema.Type<typeof StreamEvent> {}

/**
 * Describes a failed stream event for diagnostics.
 * @param {StreamEvent} event A `response.failed` or `error` event.
 * @returns {string} The backend's message, or the event type.
 */
const eventFailure = (event: StreamEvent): string =>
  Option.firstSomeOf([
    Option.fromUndefinedOr(event.message),
    Option.fromUndefinedOr(event.response).pipe(
      Option.flatMap((response) => Option.fromNullishOr(response.error)),
      Option.flatMap((failure) => Option.fromUndefinedOr(failure.message)),
    ),
  ]).pipe(Option.getOrElse(() => event.type))

/**
 * Folds one stream event into the text received so far.
 * @param {string} model The requested model, for errors.
 * @returns {Function} The fold step, failing on error events.
 */
const appendEvent =
  (model: string) =>
  (text: string, event: StreamEvent): Effect.Effect<string, RequestFailed> =>
    Match.value(event.type).pipe(
      Match.when("response.output_text.delta", () =>
        Effect.succeed(text + (event.delta ?? "")),
      ),
      Match.whenOr("response.failed", "error", () =>
        Effect.fail(
          new RequestFailed({
            cause: eventFailure(event),
            model,
            operation: "stream",
          }),
        ),
      ),
      Match.orElse(() => Effect.succeed(text)),
    )

/**
 * Reads a streaming Responses body into the model's final text.
 * @param {string} model The requested model, for errors.
 * @param {HttpClientResponse.HttpClientResponse} response A success response.
 * @returns {Effect.Effect<string, RequestFailed>} The output text.
 */
const readOutputText = (
  model: string,
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, RequestFailed> =>
  response.stream.pipe(
    Stream.decodeText(),
    Stream.pipeThroughChannel(Sse.decodeDataSchema(StreamEvent)),
    Stream.map((event) => event.data),
    streamFailed(model),
    Stream.runFoldEffect(() => "", appendEvent(model)),
  )

export { readOutputText }
