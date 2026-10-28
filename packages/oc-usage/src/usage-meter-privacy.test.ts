import { Effect, Layer, Option, Schema, flow } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import CapturedSpans from "./captured-spans.test-support.ts"
import { FetchHttpClient } from "effect/http"
import type { Scope } from "effect"
import UsageMeter from "./usage-meter.ts"
import type { Vitest } from "@effect/vitest"

interface Tests {
  readonly effect: Vitest.Test<
    CapturedLogs | CapturedSpans | UsageMeter | Scope.Scope
  >
}

const PRIVATE_ACCOUNT = "SYNTHETIC_PRIVATE_ACCOUNT",
  PRIVATE_TOKEN = "SYNTHETIC_PRIVATE_TOKEN",
  REQUEST = {
    headers: {
      authorization: `Bearer ${PRIVATE_TOKEN}`,
      "chatgpt-account-id": PRIVATE_ACCOUNT,
    },
    read: (): Option.Option<never> => Option.none(),
    reconnect: "Reconnect.",
    service: "Synthetic",
    url: "https://usage.test",
  },
  diagnosticJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  failing: typeof globalThis.fetch = flow(
    () =>
      Effect.die(
        new Error(`Transport contains ${PRIVATE_TOKEN} ${PRIVATE_ACCOUNT}`),
      ),
    Effect.runPromise,
  ),
  transport = Layer.succeed(FetchHttpClient.Fetch, failing),
  usage = UsageMeter.live.pipe(Layer.provide(transport)),
  withDiagnostics = usage.pipe(
    Layer.provideMerge(Layer.merge(CapturedLogs.layer, CapturedSpans.layer)),
  )

describe("authenticated request diagnostics", () => {
  test.layer(withDiagnostics)((it: Tests) => {
    it.effect(
      "keeps transport causes and authorization/account headers out of logs and spans",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const logs = yield* CapturedLogs,
            meter = yield* UsageMeter,
            outcome = yield* meter.measure(REQUEST),
            spans = yield* CapturedSpans,
            text = yield* Effect.all([logs.records, spans.records]).pipe(
              Effect.flatMap(diagnosticJson),
            )

          expect(UsageMeter.Outcome.$is("Unreachable")(outcome)).toBe(true)
          expect(text).not.toContain(PRIVATE_TOKEN)
          expect(text).not.toContain(PRIVATE_ACCOUNT)
          expect(
            (yield* spans.records).map((record) => ({
              attributes: record.attributes,
              events: record.events,
              name: record.name,
            })),
          ).toStrictEqual([
            { attributes: {}, events: [], name: "UsageMeter.measure" },
          ])
        }),
    )
  })
})
