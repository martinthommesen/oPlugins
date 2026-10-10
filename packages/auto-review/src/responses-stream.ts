import { Effect, Match, Option, Schema, String as Str, Stream } from "effect"
import { RequestFailed, streamFailed } from "./errors/request-failed.ts"
import type { HttpClientResponse } from "effect/unstable/http"
import { Sse } from "effect/unstable/encoding"

const ResponseError = Schema.Struct({
  code: Schema.optionalKey(Schema.NullOr(Schema.String)),
  message: Schema.optionalKey(Schema.String),
})

const ResponseState = Schema.Struct({
  error: Schema.optionalKey(Schema.NullOr(ResponseError)),
  status: Schema.optionalKey(Schema.String),
})

/** The fields of a Responses stream event the client reads. */
const StreamEvent = Schema.Struct({
  delta: Schema.optionalKey(Schema.String),
  message: Schema.optionalKey(Schema.String),
  response: Schema.optionalKey(ResponseState),
  type: Schema.String,
})

interface StreamEvent extends Schema.Schema.Type<typeof StreamEvent> {}

interface Output {
  readonly completed: boolean
  readonly text: string
}

const MAX_OUTPUT_CHARS = 16_000

const decodeEvent = Schema.decodeUnknownEffect(
  Schema.fromJsonString(StreamEvent),
)

const eventFailure = (event: StreamEvent): string =>
  Option.firstSomeOf([
    Option.fromUndefinedOr(event.message),
    Option.fromUndefinedOr(event.response).pipe(
      Option.flatMap((response) => Option.fromNullishOr(response.error)),
      Option.flatMap((failure) => Option.fromUndefinedOr(failure.message)),
    ),
  ]).pipe(Option.getOrElse(() => event.type))

const failStream = (model: string, cause: string): RequestFailed =>
  new RequestFailed({ cause, model, operation: "stream" })

const appendEvent =
  (model: string) =>
  (output: Output, event: StreamEvent): Effect.Effect<Output, RequestFailed> =>
    Match.value(event.type).pipe(
      Match.when("response.output_text.delta", () => {
        const text = output.text + (event.delta ?? "")

        if (text.length > MAX_OUTPUT_CHARS) {
          return Effect.fail(
            failStream(model, "Reviewer output exceeds its size limit."),
          )
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
          return Effect.fail(
            failStream(model, "Response did not complete successfully."),
          )
        }

        return Effect.succeed({ completed: true, text: output.text })
      }),
      Match.whenOr(
        "response.failed",
        "response.incomplete",
        "response.refusal.delta",
        "response.refusal.done",
        "error",
        () => Effect.fail(failStream(model, eventFailure(event))),
      ),
      Match.orElse(() => Effect.succeed(output)),
    )

const readOutputText = Effect.fn("CodexResponses.readOutputText")(
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
      streamFailed(model),
      Stream.runFoldEffect(
        (): Output => ({ completed: false, text: "" }),
        appendEvent(model),
      ),
    )

    if (!output.completed || Str.isEmpty(Str.trim(output.text))) {
      return yield* failStream(
        model,
        "Stream ended without a completed assessment.",
      )
    }

    return output.text
  },
)

export { readOutputText }
