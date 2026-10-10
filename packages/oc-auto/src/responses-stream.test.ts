import { Array as Arr, Effect, Fiber, Schema, pipe } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "@effect/vitest"
import RequestFailed from "./request-failed-error.ts"
import { TestClock } from "effect/testing"
import responsesStream from "./responses-stream.ts"

const ALLOW =
    'data: {"type":"response.output_text.delta","delta":"{\\"outcome\\":\\"allow\\"}"}\n\n',
  COMPLETED =
    'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
  OVERSIZED_OUTPUT_CHARS = 20_000,
  REQUEST = HttpClientRequest.post("https://example.com/responses"),
  encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  isRequestFailed = Schema.is(RequestFailed),
  /* The reviewer's text read from a response whose body is `body`. */
  read = (body: string): Effect.Effect<string, RequestFailed> =>
    responsesStream.readOutputText(
      "codex-auto-review",
      HttpClientResponse.fromWeb(REQUEST, new Response(body)),
    )

describe("readOutputText", () => {
  it.effect(
    "requires a completed response before returning the assessment",
    () =>
      Effect.gen(function* completed() {
        expect.hasAssertions()

        const text = yield* read(`${ALLOW}${COMPLETED}data: [DONE]\n\n`)

        expect(text).toBe('{"outcome":"allow"}')
      }),
  )

  it.effect("does not accept an approval from a stream that ends early", () =>
    Effect.gen(function* endedEarly() {
      expect.hasAssertions()

      const failure = yield* read(ALLOW).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(RequestFailed)
    }),
  )

  it.effect(
    "does not treat the done sentinel alone as successful completion",
    () =>
      Effect.gen(function* onlySentinel() {
        expect.hasAssertions()

        const failure = yield* read(`${ALLOW}data: [DONE]\n\n`).pipe(
          Effect.flip,
        )

        expect(failure).toBeInstanceOf(RequestFailed)
      }),
  )
})

describe("response terminal failures", () => {
  it.effect(
    "rejects incomplete or failed terminal events after approval text",
    () =>
      Effect.gen(function* unsuccessful() {
        expect.hasAssertions()

        const events = [
            { response: { status: "incomplete" }, type: "response.incomplete" },
            { type: "response.failed" },
            { response: { status: "incomplete" }, type: "response.completed" },
            {
              response: { error: { message: "Failed" }, status: "completed" },
              type: "response.completed",
            },
            { type: "response.completed" },
            { type: "response.refusal.done" },
          ] as const,
          failures = yield* pipe(
            events,
            Effect.forEach((event) =>
              read(`${ALLOW}data: ${JSON.stringify(event)}\n\n`).pipe(
                Effect.flip,
              ),
            ),
          )

        expect(pipe(failures, Arr.every(isRequestFailed))).toBe(true)
      }),
  )

  it.effect("rejects empty or malformed stream content", () =>
    Effect.gen(function* malformedStream() {
      expect.hasAssertions()

      const failures = yield* Effect.all([
        read(COMPLETED).pipe(Effect.flip),
        read(`data: not JSON\n\n${COMPLETED}`).pipe(Effect.flip),
      ])

      expect(pipe(failures, Arr.every(isRequestFailed))).toBe(true)
    }),
  )
})

describe("response output limits", () => {
  it.effect("bounds accumulated reviewer output", () =>
    Effect.gen(function* largeOutput() {
      expect.hasAssertions()

      const event = yield* encodeJson({
          delta: "x".repeat(OVERSIZED_OUTPUT_CHARS),
          type: "response.output_text.delta",
        }),
        failure = yield* read(`data: ${event}\n\n${COMPLETED}`).pipe(
          Effect.flip,
        )

      expect(failure).toBeInstanceOf(RequestFailed)
    }),
  )
})

describe("response stream finalization", () => {
  it.effect(
    "stops reading once completion arrives even if the connection stays open",
    () =>
      Effect.gen(function* openConnection() {
        expect.hasAssertions()

        let cancelled = false

        const body = new ReadableStream<Uint8Array>({
            cancel(): void {
              cancelled = true
            },
            start(
              controller: Readonly<ReadableStreamDefaultController<Uint8Array>>,
            ): void {
              controller.enqueue(
                new TextEncoder().encode(`${ALLOW}${COMPLETED}`),
              )
            },
          }),
          reading = yield* responsesStream
            .readOutputText(
              "codex-auto-review",
              HttpClientResponse.fromWeb(REQUEST, new Response(body)),
            )
            .pipe(
              Effect.timeoutOrElse({
                duration: "1 second",
                orElse: () => Effect.succeed("timed out"),
              }),
              Effect.forkChild,
            )

        yield* TestClock.adjust("1 second")

        expect(yield* Fiber.join(reading)).toBe('{"outcome":"allow"}')
        expect(cancelled).toBe(true)
      }),
  )
})
