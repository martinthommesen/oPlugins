import { Deferred, Effect, Fiber, Layer, Option, Ref, Schema } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import NativeHttp from "./native-http.test-support.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import UsageMeter from "./usage-meter.ts"
import type { Vitest } from "@effect/vitest"

interface Tests {
  readonly effect: Vitest.Test<
    CapturedLogs | NativeHttp | UsageMeter | Scope.Scope
  >
}

const HTTP_UNAVAILABLE = 503,
  PRIVATE_TOKEN = "SYNTHETIC_PRIVATE_TOKEN",
  REQUEST = {
    headers: { authorization: `Bearer ${PRIVATE_TOKEN}` },
    read: (): Option.Option<never> => Option.none(),
    reconnect: "Reconnect.",
    service: "Synthetic",
    url: "https://usage.test",
  },
  encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  measured = UsageMeter.pipe(Effect.flatMap((meter) => meter.measure(REQUEST)))

describe("native HTTP lifetimes", () => {
  test.layer(NativeHttp.success.pipe(Layer.provideMerge(CapturedLogs.layer)))(
    (it: Tests) => {
      it.effect(
        "bounds a body stalled after headers and aborts the request",
        () =>
          Effect.gen(function* run() {
            expect.hasAssertions()

            const native = yield* NativeHttp,
              waiting = yield* Effect.forkChild(measured)

            yield* Deferred.await(native.bodyStarted)
            yield* TestClock.adjust("15 seconds")
            expect(
              UsageMeter.Outcome.$is("Unreachable")(yield* Fiber.join(waiting)),
            ).toBe(true)
            expect(
              (yield* Ref.get(native.signals)).map((signal) => signal.aborted),
            ).toStrictEqual([true])
          }),
      )
    },
  )
})

describe("native HTTP cleanup", () => {
  test.layer(
    NativeHttp.layer(HTTP_UNAVAILABLE).pipe(
      Layer.provideMerge(CapturedLogs.layer),
    ),
  )((it: Tests) => {
    it.effect(
      "releases an unread error body and keeps credentials out of all diagnostics",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const logs = yield* CapturedLogs,
            native = yield* NativeHttp,
            outcome = yield* measured

          expect(outcome).toStrictEqual(
            UsageMeter.Outcome.Unreachable({
              problem:
                "Synthetic answered with HTTP 503. Retry /usage later; if it persists, check usage_request_failed in OpenCode's server log.",
            }),
          )
          expect(
            (yield* Ref.get(native.signals)).map((signal) => signal.aborted),
          ).toStrictEqual([true])
          expect(yield* Ref.get(native.forwarded)).toStrictEqual([
            { headers: REQUEST.headers, method: "GET", redirect: "error" },
          ])
          expect(
            yield* logs.records.pipe(Effect.flatMap(encodeJson)),
          ).not.toContain(PRIVATE_TOKEN)
        }),
    )
  })
})
