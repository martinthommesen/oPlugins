import { Effect, Fiber, pipe } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/unstable/http"
import { describe, expect, it } from "@effect/vitest"
import { RequestFailed } from "./errors/request-failed.ts"
import { TestClock } from "effect/testing"
import { readOutputText } from "./responses-stream.ts"

const ALLOW =
  'data: {"type":"response.output_text.delta","delta":"{\\"outcome\\":\\"allow\\"}"}\n\n'

const COMPLETED =
  'data: {"type":"response.completed","response":{"status":"completed"}}\n\n'

const OVERSIZED_OUTPUT_CHARS = 20_000

const request = HttpClientRequest.post("https://example.com/responses")

const read = (body: string): Effect.Effect<string, RequestFailed> =>
  readOutputText(
    "codex-auto-review",
    HttpClientResponse.fromWeb(request, new Response(body)),
  )

describe(readOutputText, () => {
  it.effect(
    "requires a completed response before returning the assessment",
    () =>
      Effect.gen(function* completed() {
        const text = yield* read(`${ALLOW}${COMPLETED}data: [DONE]\n\n`)

        expect(text).toBe('{"outcome":"allow"}')
      }),
  )

  it.effect("does not accept an approval from a stream that ends early", () =>
    Effect.gen(function* endedEarly() {
      const failure = yield* read(ALLOW).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(RequestFailed)
    }),
  )

  it.effect(
    "does not treat the done sentinel alone as successful completion",
    () =>
      Effect.gen(function* onlySentinel() {
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
        ] as const

        const failures = yield* pipe(
          events,
          Effect.forEach((event) =>
            read(`${ALLOW}data: ${JSON.stringify(event)}\n\n`).pipe(
              Effect.flip,
            ),
          ),
        )

        expect(
          failures.every((failure) => failure instanceof RequestFailed),
        ).toBe(true)
      }),
  )

  it.effect("rejects empty or malformed stream content", () =>
    Effect.gen(function* malformedStream() {
      const failures = yield* Effect.all([
        read(COMPLETED).pipe(Effect.flip),
        read(`data: not JSON\n\n${COMPLETED}`).pipe(Effect.flip),
      ])

      expect(
        failures.every((failure) => failure instanceof RequestFailed),
      ).toBe(true)
    }),
  )
})

describe("response output limits", () => {
  it.effect("bounds accumulated reviewer output", () =>
    Effect.gen(function* largeOutput() {
      const event = {
        delta: "x".repeat(OVERSIZED_OUTPUT_CHARS),
        type: "response.output_text.delta",
      }

      const failure = yield* read(
        `data: ${JSON.stringify(event)}\n\n${COMPLETED}`,
      ).pipe(Effect.flip)

      expect(failure).toBeInstanceOf(RequestFailed)
    }),
  )
})

describe("response stream finalization", () => {
  it.effect(
    "stops reading once completion arrives even if the connection stays open",
    () =>
      Effect.gen(function* openConnection() {
        let cancelled = false

        const body = new ReadableStream<Uint8Array>({
          cancel(): void {
            cancelled = true
          },
          start(
            controller: Readonly<ReadableStreamDefaultController<Uint8Array>>,
          ): void {
            controller.enqueue(new TextEncoder().encode(`${ALLOW}${COMPLETED}`))
          },
        })

        const response = HttpClientResponse.fromWeb(request, new Response(body))

        const fiber = yield* readOutputText("codex-auto-review", response).pipe(
          Effect.timeoutOrElse({
            duration: "1 second",
            orElse: () => Effect.succeed("timed out"),
          }),
          Effect.forkChild,
        )

        yield* TestClock.adjust("1 second")
        const text = yield* Fiber.join(fiber)

        expect(text).toBe('{"outcome":"allow"}')
        expect(cancelled).toBe(true)
      }),
  )
})
