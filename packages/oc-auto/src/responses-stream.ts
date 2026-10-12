import { Effect, Match, Option, Schema, String as Str, Stream } from "effect"
import type { HttpClientResponse } from "effect/http"
import RequestFailed from "./request-failed-error.ts"
import { Sse } from "effect/encoding"
import type requestFailure from "./request-failure.ts"

type ReceivedEvent = typeof StreamEvent.Type

interface Output {
  readonly completed: boolean
  readonly text: string
}

const EventError = Schema.Struct({
    code: Schema.optionalKey(Schema.NullOr(Schema.String)),
    message: Schema.optionalKey(Schema.String),
  }),
  EventResponse = Schema.Struct({
    error: Schema.optionalKey(Schema.NullOr(EventError)),
    status: Schema.optionalKey(Schema.String),
  }),
  MAX_OUTPUT_CHARS = 16_000,
  /** The fields of a Responses stream event the client reads. */
  StreamEvent = Schema.Struct({
    delta: Schema.optionalKey(Schema.String),
    message: Schema.optionalKey(Schema.String),
    response: Schema.optionalKey(EventResponse),
    type: Schema.String,
  }),
  decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(StreamEvent)),
  /* What a failed event says went wrong. */
  eventFailure = (event: ReceivedEvent): string =>
    Option.firstSomeOf([
      Option.fromUndefinedOr(event.message),
      Option.fromUndefinedOr(event.response).pipe(
        Option.flatMap((response) => Option.fromNullishOr(response.error)),
        Option.flatMap((failure) => Option.fromUndefinedOr(failure.message)),
      ),
    ]).pipe(Option.getOrElse(() => event.type)),
  /*
   * A stream failure of a known kind. `cause` may quote the provider, so
   * only `category` is ever reported.
   */
  failStream = (
    model: string,
    category: typeof requestFailure.Category.Type,
    cause: string,
  ): RequestFailed =>
    RequestFailed.make({
      category,
      cause,
      model,
      operation: "stream",
      status: Option.none(),
    }),
  failTooLong = (model: string): RequestFailed =>
    failStream(
      model,
      "output_too_large",
      "Reviewer output exceeds its size limit.",
    ),
  failUnfinished = (model: string): RequestFailed =>
    failStream(model, "incomplete", "Response did not complete successfully."),
  /* The category of an event that ends the stream without an answer. */
  failedCategory = (type: string): typeof requestFailure.Category.Type =>
    Match.value(type).pipe(
      Match.when("response.incomplete", () => "incomplete" as const),
      Match.whenOr(
        "response.refusal.delta",
        "response.refusal.done",
        () => "refused" as const,
      ),
      Match.orElse(() => "response_failed" as const),
    ),
  /* Adds one stream event to the output read so far. */
  foldEvent =
    (model: string) =>
    (
      output: Output,
      event: ReceivedEvent,
    ): Effect.Effect<Output, RequestFailed> =>
      Match.value(event.type).pipe(
        Match.when("response.output_text.delta", () => {
          const text = output.text + (event.delta ?? "")

          if (text.length > MAX_OUTPUT_CHARS) {
            return Effect.fail(failTooLong(model))
          }

          return Effect.succeed({ completed: false, text })
        }),
        Match.when("response.completed", () => {
          const completed = Option.fromUndefinedOr(event.response).pipe(
            Option.filter((response) => response.status === "completed"),
            Option.filter((response) =>
              Option.isNone(Option.fromNullishOr(response.error)),
            ),
          )

          if (Option.isNone(completed)) {
            return Effect.fail(failUnfinished(model))
          }

          return Effect.succeed({ completed: true, text: output.text })
        }),
        Match.whenOr(
          "error",
          "response.failed",
          "response.incomplete",
          "response.refusal.delta",
          "response.refusal.done",
          (type) =>
            Effect.fail(
              failStream(model, failedCategory(type), eventFailure(event)),
            ),
        ),
        Match.orElse(() => Effect.succeed(output)),
      ),
  /* The reviewer's final text from a completed Responses stream. */
  readOutputText = Effect.fn("CodexResponses.readOutputText")(
    function* readOutputText(
      model: string,
      response: HttpClientResponse.HttpClientResponse,
    ) {
      const output = yield* response.stream.pipe(
        Stream.decodeText(),
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.filter((event) => event.data !== "[DONE]"),
        Stream.mapEffect((event) => decodeEvent(event.data)),
        Stream.takeUntil((event) => event.type === "response.completed"),
        RequestFailed.whileStreaming(model),
        Stream.runFoldEffect(
          (): Output => ({ completed: false, text: "" }),
          foldEvent(model),
        ),
      )

      if (!output.completed || Str.isEmpty(Str.trim(output.text))) {
        return yield* failStream(
          model,
          "incomplete",
          "Stream ended without a completed assessment.",
        )
      }

      return output.text
    },
  )

/** Reads the reviewer's answer from a Responses event stream. */
/** @internal */
export default Object.freeze({ readOutputText })
