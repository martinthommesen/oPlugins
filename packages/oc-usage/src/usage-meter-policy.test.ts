import { Duration, Effect, Layer, Option } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import FakeService from "./fake-service.test-support.ts"
import type { Scope } from "effect"
import UsageMeter from "./usage-meter.ts"
import type { Vitest } from "@effect/vitest"

interface Tests {
  readonly effect: Vitest.Test<UsageMeter | Scope.Scope>
}

const DEFAULT_MINUTES = 10,
  FORBIDDEN = 403,
  LIMITED = 429,
  REQUEST = {
    headers: {},
    read: (): Option.Option<never> => Option.none(),
    reconnect: "Reconnect.",
    service: "Synthetic",
    url: "https://usage.test",
  },
  measured = UsageMeter.pipe(Effect.flatMap((meter) => meter.measure(REQUEST))),
  meterFor = (
    headers: Readonly<Record<string, string>>,
    status: number,
  ): Layer.Layer<UsageMeter> =>
    UsageMeter.layer.pipe(
      Layer.provide(
        FakeService.layer(() =>
          Effect.sync(() => new Response("private body", { headers, status })),
        ),
      ),
    ),
  wait = measured.pipe(
    Effect.map((outcome) =>
      UsageMeter.Outcome.$match(outcome, {
        Ineligible: () => Option.none(),
        Limited: (limited) => Option.some(limited.wait),
        Read: () => Option.none(),
        Rejected: () => Option.none(),
        Unreachable: () => Option.none(),
      }),
    ),
  )

describe("retry header syntax", () => {
  describe.each([
    "",
    " ",
    "0x10",
    "0b10",
    "1e2",
    "-1",
    "bad",
    "Wed, 21 Oct 2026 07:28:00 GMT",
  ])("uses the fallback for %j", (header) => {
    test.layer(meterFor({ "retry-after": header }, LIMITED))((it: Tests) => {
      it.effect("does not coerce malformed seconds", () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          expect(yield* wait).toStrictEqual(
            Option.some(Duration.minutes(DEFAULT_MINUTES)),
          )
        }),
      )
    })
  })
})

describe("json media types", () => {
  test.layer(
    meterFor({ "content-type": "Application/JSON; charset=utf-8" }, FORBIDDEN),
  )((it: Tests) => {
    it.effect(
      "recognizes media types without depending on their letter case",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          expect(UsageMeter.Outcome.$is("Rejected")(yield* measured)).toBe(true)
        }),
    )
  })

  test.layer(meterFor({ "content-type": "text/html; note=json" }, FORBIDDEN))(
    (it: Tests) => {
      it.effect("does not mistake a parameter for a JSON media type", () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          expect(UsageMeter.Outcome.$is("Unreachable")(yield* measured)).toBe(
            true,
          )
        }),
      )
    },
  )
})
