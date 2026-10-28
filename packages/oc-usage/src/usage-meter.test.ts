import { Duration, Effect, Fiber, Layer, Option, Ref } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import FakeService from "./fake-service.test-support.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import UsageMeter from "./usage-meter.ts"
import type { Vitest } from "@effect/vitest"

type Responder = Parameters<typeof FakeService.layer>[typeof FIRST]

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<FakeService | UsageMeter | Scope.Scope>
}

const DEFAULT_WAIT_MINUTES = 10,
  FIRST = 0,
  HTTP_FORBIDDEN = 403,
  HTTP_OK = 200,
  HTTP_TOO_MANY_REQUESTS = 429,
  HTTP_UNAUTHORIZED = 401,
  HTTP_UNAVAILABLE = 503,
  JSON_TYPE = { "content-type": "application/json" },
  READING = { plan: Option.some("Max"), windows: [] },
  /** A usage request to a service that answers with usage when its body is `usage`. */
  REQUEST = {
    headers: { authorization: "Bearer token" },
    read: (body: string): Option.Option<typeof READING> =>
      Option.liftPredicate(body, (text) => text === "usage").pipe(
        Option.as(READING),
      ),
    reconnect: "Run claude to sign in again.",
    service: "Anthropic",
    url: "https://usage.test/api/oauth/usage",
  },
  RETRY_SECONDS = 120,
  /* A responder that answers every request with `body` and `status`. */
  answering =
    (
      body: string,
      status: number,
      headers: Readonly<Record<string, string>> = {},
    ): Responder =>
    () =>
      Effect.sync(() => new Response(body, { headers, status })),
  /* What measuring `REQUEST` comes to. */
  measured = UsageMeter.pipe(Effect.flatMap((meter) => meter.measure(REQUEST))),
  /* The meter over a service that answers with `respond`. */
  meterOver = (respond: Responder): Layer.Layer<FakeService | UsageMeter> =>
    UsageMeter.layer.pipe(Layer.provideMerge(FakeService.layer(respond)))

describe("a successful usage answer", () => {
  test.layer(meterOver(answering("usage", HTTP_OK)))((it: Tests) => {
    it.effect("is read, from a request that follows no redirect", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const fake = yield* FakeService,
          outcome = yield* measured,
          requests = yield* Ref.get(fake.requests)

        expect(outcome).toStrictEqual(
          UsageMeter.Outcome.Read({ reading: READING }),
        )
        expect(requests.map((request) => request.url)).toStrictEqual([
          REQUEST.url,
        ])
        expect(
          requests.map((request) => request.headers["authorization"]),
        ).toStrictEqual(["Bearer token"])
        expect(yield* Ref.get(fake.redirects)).toStrictEqual(["error"])
      }),
    )
  })

  test.layer(meterOver(answering("<html>", HTTP_OK)))((it: Tests) => {
    it.effect("that isn't usage is a problem", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* measured).toStrictEqual(
          UsageMeter.Outcome.Unreachable({
            problem:
              "Anthropic answered with usage that oc-usage can't read. Update oc-usage; if it persists, report the service name and plugin version.",
          }),
        )
      }),
    )
  })
})

describe("a refused sign-in", () => {
  test.layer(meterOver(answering("{}", HTTP_UNAUTHORIZED, JSON_TYPE)))(
    (it: Tests) => {
      it.effect("is rejected, with what to do", () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          expect(yield* measured).toStrictEqual(
            UsageMeter.Outcome.Rejected({
              problem:
                "Anthropic refused the sign-in (HTTP 401). Run claude to sign in again.",
            }),
          )
        }),
      )
    },
  )

  test.layer(meterOver(answering("{}", HTTP_FORBIDDEN, JSON_TYPE)))(
    (it: Tests) => {
      it.effect("is rejected when the service forbids it", () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          expect(yield* measured).toStrictEqual(
            UsageMeter.Outcome.Rejected({
              problem:
                "Anthropic refused the sign-in (HTTP 403). Run claude to sign in again.",
            }),
          )
        }),
      )
    },
  )

  test.layer(meterOver(answering("<html>", HTTP_FORBIDDEN)))((it: Tests) => {
    it.effect("isn't a forbidding page that isn't the service's", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* measured).toStrictEqual(
          UsageMeter.Outcome.Unreachable({
            problem:
              "Anthropic answered with HTTP 403. Retry /usage later; if it persists, check usage_request_failed in OpenCode's server log.",
          }),
        )
      }),
    )
  })
})

describe("a malformed retry interval", () => {
  test.layer(
    meterOver(
      answering("{}", HTTP_TOO_MANY_REQUESTS, { "retry-after": "1e308" }),
    ),
  )((it: Tests) => {
    it.effect("uses a finite fallback when seconds would overflow", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* measured).toStrictEqual(
          UsageMeter.Outcome.Limited({
            problem:
              "Anthropic is limiting usage requests, so oc-usage waits before it asks again.",
            wait: Duration.minutes(DEFAULT_WAIT_MINUTES),
          }),
        )
      }),
    )
  })
})

describe("a rate-limited answer", () => {
  test.layer(
    meterOver(
      answering("{}", HTTP_TOO_MANY_REQUESTS, {
        "retry-after": `${RETRY_SECONDS}`,
      }),
    ),
  )((it: Tests) => {
    it.effect("asks for the wait its retry-after header names", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* measured).toStrictEqual(
          UsageMeter.Outcome.Limited({
            problem:
              "Anthropic is limiting usage requests, so oc-usage waits before it asks again.",
            wait: Duration.seconds(RETRY_SECONDS),
          }),
        )
      }),
    )
  })

  test.layer(meterOver(answering("{}", HTTP_TOO_MANY_REQUESTS)))(
    (it: Tests) => {
      it.effect("without a retry-after header waits ten minutes", () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          expect(
            UsageMeter.Outcome.$match(yield* measured, {
              Ineligible: () => Option.none(),
              Limited: ({ wait }) => Option.some(wait),
              Read: () => Option.none(),
              Rejected: () => Option.none(),
              Unreachable: () => Option.none(),
            }),
          ).toStrictEqual(Option.some(Duration.minutes(DEFAULT_WAIT_MINUTES)))
        }),
      )
    },
  )
})

describe("a service that can't answer", () => {
  test.layer(meterOver(answering("", HTTP_UNAVAILABLE)))((it: Tests) => {
    it.effect("names the status it answered with", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* measured).toStrictEqual(
          UsageMeter.Outcome.Unreachable({
            problem:
              "Anthropic answered with HTTP 503. Retry /usage later; if it persists, check usage_request_failed in OpenCode's server log.",
          }),
        )
      }),
    )
  })

  test.layer(meterOver(FakeService.unreachable))((it: Tests) => {
    it.effect("says it couldn't be reached", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(yield* measured).toStrictEqual(
          UsageMeter.Outcome.Unreachable({
            problem:
              "oc-usage couldn't reach Anthropic. Retry /usage later; if it persists, check your network and OpenCode's server log.",
          }),
        )
      }),
    )
  })

  test.layer(meterOver(() => Effect.never))((it: Tests) => {
    it.effect("gives up after 15 seconds", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const waiting = yield* Effect.forkChild(measured)

        yield* TestClock.adjust("15 seconds")

        expect(yield* Fiber.join(waiting)).toStrictEqual(
          UsageMeter.Outcome.Unreachable({
            problem:
              "Anthropic didn't answer within 15 seconds. Retry /usage later; if it persists, check the service and OpenCode's server log.",
          }),
        )
      }),
    )
  })
})
