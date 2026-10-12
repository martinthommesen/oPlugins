import { Match, Option, Schema, String as Str } from "effect"

/** A failure's category, and the HTTP status the backend answered with. */
interface Classified {
  readonly category: typeof Category.Type
  readonly status: Option.Option<number>
}

/** A failed request to the reviewer, as the user and the log hear of it. */
interface Failed extends Classified {
  readonly model: string
  readonly operation: string
}

/** The fields of the warning that records a failed request. */
type LogFields = Readonly<{
  category: typeof Category.Type
  error: "RequestFailed"
  model: string
  operation: string
  status?: number
}>

/* The HTTP status of a response, as an HTTP client failure carries it. */
const Answered = { response: Schema.Struct({ status: Schema.Finite }) },
  /** A request body the plugin could not encode. */
  BodyFailure = Schema.TaggedStruct("HttpBodyError", {}),
  /*
   * Why a request to the reviewer failed: a bounded vocabulary the log and
   * the prompt may carry. A category comes from a structured failure or a
   * known local outcome, never from the provider's text; `unknown` covers
   * the rest.
   */
  Category = Schema.Literals([
    "incomplete",
    "invalid_request",
    "invalid_response",
    "network",
    "output_too_large",
    "rate_limited",
    "refused",
    "request_rejected",
    "response_failed",
    "server_error",
    "unknown",
  ]),
  /*
   * What each category tells the user: what went wrong, and what to do
   * about it, if anything.
   */
  EXPLAINED = {
    incomplete: [
      "The reviewer's answer ended before it was complete",
      "Try again.",
    ],
    invalid_request: ["The plugin could not build the review request", ""],
    invalid_response: [
      "The reviewer backend sent a response the plugin could not read",
      "Try again.",
    ],
    network: [
      "The reviewer backend could not be reached",
      "Check the network connection.",
    ],
    output_too_large: ["The reviewer's answer exceeded its size limit", ""],
    rate_limited: [
      "The reviewer backend is limiting requests",
      "Wait a few minutes before you rely on auto-review again.",
    ],
    refused: ["The reviewer refused to assess this request", ""],
    request_rejected: ["The reviewer backend rejected the request", ""],
    response_failed: [
      "The reviewer backend reported that the review failed",
      "Try again.",
    ],
    server_error: ["The reviewer backend had an error", "Try again later."],
    unknown: ["The review request failed", ""],
  } as const satisfies Record<
    typeof Category.Type,
    readonly [what: string, guidance: string]
  >,
  HTTP_SERVER_ERROR = 500,
  HTTP_TOO_MANY_REQUESTS = 429,
  /** The structured part of an HTTP client failure: its reason. */
  HttpFailure = Schema.Struct({
    reason: Schema.Union([
      Schema.TaggedStruct("DecodeError", Answered),
      Schema.TaggedStruct("EmptyBodyError", Answered),
      Schema.TaggedStruct("EncodeError", {}),
      Schema.TaggedStruct("InvalidUrlError", {}),
      Schema.TaggedStruct("StatusCodeError", Answered),
      Schema.TaggedStruct("TransportError", {}),
    ]),
  }),
  /** A failure of the event stream's own format. */
  StreamFailure = Schema.Union([
    Schema.TaggedStruct("Retry", {}),
    Schema.TaggedStruct("SseError", {}),
  ]),
  /* A failure's category, with an HTTP status when it has one. */
  answered = (
    category: typeof Category.Type,
    status: Option.Option<number>,
  ): Classified => ({ category, status }),
  /* The category of an HTTP status the backend answered with. */
  categoryOfStatus = (status: number): typeof Category.Type => {
    if (status === HTTP_TOO_MANY_REQUESTS) {
      return "rate_limited"
    }

    if (status >= HTTP_SERVER_ERROR) {
      return "server_error"
    }

    return "request_rejected"
  },
  /*
   * What the user is told about a failed request: what went wrong, with the
   * HTTP status, or the failed step when nothing else names the cause, then
   * what to do about it.
   */
  explain = (failure: Failed): string => {
    const [what, guidance] = EXPLAINED[failure.category],
      step = Option.liftPredicate(
        ` while running "${failure.operation}"`,
        () => failure.category === "unknown",
      ),
      suffix = Option.match(failure.status, {
        onNone: () => Option.getOrElse(step, () => ""),
        onSome: (status) => ` (HTTP ${status})`,
      })

    return [`${what}${suffix}.`, guidance]
      .filter((part) => Str.isNonEmpty(part))
      .join(" ")
  },
  /* The warning's fields for a failed request: metadata only. */
  logFields = (failure: Failed): LogFields =>
    Option.match(failure.status, {
      onNone: () => ({
        category: failure.category,
        error: "RequestFailed" as const,
        model: failure.model,
        operation: failure.operation,
      }),
      onSome: (status) => ({
        category: failure.category,
        error: "RequestFailed" as const,
        model: failure.model,
        operation: failure.operation,
        status,
      }),
    }),
  /* The category and HTTP status of an HTTP client failure. */
  ofHttpFailure = (failure: typeof HttpFailure.Type): Classified =>
    Match.valueTags(failure.reason, {
      DecodeError: ({ response }) =>
        answered("invalid_response", Option.some(response.status)),
      EmptyBodyError: ({ response }) =>
        answered("invalid_response", Option.some(response.status)),
      EncodeError: () => answered("invalid_request", Option.none()),
      InvalidUrlError: () => answered("invalid_request", Option.none()),
      StatusCodeError: ({ response }) =>
        answered(
          categoryOfStatus(response.status),
          Option.some(response.status),
        ),
      TransportError: () => answered("network", Option.none()),
    }),
  /*
   * The category, and HTTP status where there is one, of what a request
   * step failed with: an HTTP client failure, an unreadable event, or
   * anything else.
   */
  ofStepFailure = (cause: unknown): Classified =>
    Option.match(Schema.decodeUnknownOption(HttpFailure)(cause), {
      onNone: () =>
        Match.value(cause).pipe(
          Match.when(Schema.is(BodyFailure), () =>
            answered("invalid_request", Option.none()),
          ),
          Match.when(Schema.isSchemaError, () =>
            answered("invalid_response", Option.none()),
          ),
          Match.when(Schema.is(StreamFailure), () =>
            answered("invalid_response", Option.none()),
          ),
          Match.orElse(() => answered("unknown", Option.none())),
        ),
      onSome: (failure) => ofHttpFailure(failure),
    })

/**
 * The categories of a failed request to the reviewer, how a failure gets
 * one, and what the user and the log hear of it.
 */
export default Object.freeze({
  Category,
  classify: ofStepFailure,
  explain,
  logFields,
})
