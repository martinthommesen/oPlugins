import { Effect, Option, Schema } from "effect"
import {
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http"
import { describe, expect, it } from "@effect/vitest"
import requestFailure from "./request-failure.ts"

const FIRST = 0,
  HTTP_BAD_REQUEST = 400,
  HTTP_OK = 200,
  HTTP_TOO_MANY_REQUESTS = 429,
  HTTP_UNAVAILABLE = 503,
  REQUEST = HttpClientRequest.post("https://example.com/responses"),
  SECOND = 1,
  /* Provider text a failure may carry, which no category may come from. */
  SECRET = "rate limit exceeded for sk-live-1234",
  THIRD = 2,
  /* A request body that could not be encoded, as the HTTP body module reports it. */
  UNENCODABLE = Schema.TaggedStruct("HttpBodyError", {
    reason: Schema.String,
  }).make({ reason: SECRET }),
  /* The backend's answer with `status`, whose body quotes the provider. */
  answer = (status: number): HttpClientResponse.HttpClientResponse =>
    HttpClientResponse.fromWeb(REQUEST, new Response(SECRET, { status })),
  /* What a failure is classified as: its category and HTTP status. */
  classified = (cause: unknown): readonly [string, Option.Option<number>] => {
    const { category, status } = requestFailure.classify(cause)

    return [category, status]
  },
  /* What checking the status of a response with `status` fails with. */
  statusFailure = (
    status: number,
  ): Effect.Effect<
    HttpClientError.HttpClientError,
    HttpClientResponse.HttpClientResponse
  > => Effect.flip(HttpClientResponse.filterStatusOk(answer(status)))

describe("an HTTP failure's category", () => {
  it.effect("comes from the HTTP status", () =>
    Effect.gen(function* fromStatus() {
      expect.hasAssertions()

      const failures = yield* Effect.all([
        statusFailure(HTTP_TOO_MANY_REQUESTS),
        statusFailure(HTTP_UNAVAILABLE),
        statusFailure(HTTP_BAD_REQUEST),
      ])

      expect([
        classified(failures[FIRST]),
        classified(failures[SECOND]),
        classified(failures[THIRD]),
      ]).toStrictEqual([
        ["rate_limited", Option.some(HTTP_TOO_MANY_REQUESTS)],
        ["server_error", Option.some(HTTP_UNAVAILABLE)],
        ["request_rejected", Option.some(HTTP_BAD_REQUEST)],
      ])
    }),
  )

  it.effect("comes from the failure's reason", () =>
    Effect.gen(function* fromReason() {
      expect.hasAssertions()

      const unreachable = new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({
            cause: SECRET,
            request: REQUEST,
          }),
        }),
        unreadable = yield* Effect.flip(answer(HTTP_OK).json)

      expect([
        classified(unreachable),
        classified(UNENCODABLE),
        classified(unreadable),
      ]).toStrictEqual([
        ["network", Option.none()],
        ["invalid_request", Option.none()],
        ["invalid_response", Option.some(HTTP_OK)],
      ])
    }),
  )
})

describe("another failure's category", () => {
  it.effect("is invalid_response for an unreadable event", () =>
    Effect.gen(function* unreadableEvent() {
      expect.hasAssertions()

      const decoding = yield* Effect.flip(
        Schema.decodeUnknownEffect(Schema.String)(HTTP_OK),
      )

      expect(classified(decoding)).toStrictEqual([
        "invalid_response",
        Option.none(),
      ])
    }),
  )

  it("is unknown when nothing structured names it", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect([
      classified(SECRET),
      classified(new Error("HTTP 429 rate limited")),
    ]).toStrictEqual([
      ["unknown", Option.none()],
      ["unknown", Option.none()],
    ])
  })
})

describe("what the user is told about a failed request", () => {
  it(
    "gives the status and guidance for the category",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect([
        requestFailure.explain({
          category: "rate_limited",
          model: "codex-auto-review",
          operation: "status",
          status: Option.some(HTTP_TOO_MANY_REQUESTS),
        }),
        requestFailure.explain({
          category: "unknown",
          model: "codex-auto-review",
          operation: "encodeBody",
          status: Option.none(),
        }),
      ]).toStrictEqual([
        "The reviewer backend is limiting requests (HTTP 429). Wait a few minutes before you rely on auto-review again.",
        'The review request failed while running "encodeBody".',
      ])
    },
  )
})
