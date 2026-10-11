import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "./captured-logs.ts"
import { Effect } from "effect"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"

/** The `it` of a `test.layer` block: `it.effect`, given the captured logs. */
interface Tests {
  readonly effect: Vitest.Test<CapturedLogs | Scope.Scope>
}

const FIRST_ATTEMPT = 1,
  SECOND_ATTEMPT = 2

describe("the captured logs", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("keep every record, at every level, oldest first", () =>
      Effect.gen(function* keepsEveryRecord() {
        expect.hasAssertions()

        yield* Effect.logDebug("refresh_started")
        yield* Effect.logInfo("plugin_started").pipe(
          Effect.annotateLogs({ project: "prj_test" }),
        )
        yield* Effect.logWarning("refresh_failed").pipe(
          Effect.annotateLogs({ attempt: SECOND_ATTEMPT, retried: true }),
        )

        expect(yield* (yield* CapturedLogs).records).toStrictEqual([
          { annotations: {}, level: "Debug", message: "refresh_started" },
          {
            annotations: { project: "prj_test" },
            level: "Info",
            message: "plugin_started",
          },
          {
            annotations: { attempt: SECOND_ATTEMPT, retried: true },
            level: "Warn",
            message: "refresh_failed",
          },
        ])
      }),
    )
  })
})

describe("the captured records of one event", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("are the records with that event, oldest first", () =>
      Effect.gen(function* findsEvent() {
        expect.hasAssertions()

        yield* Effect.logInfo("plugin_started")
        yield* Effect.logWarning("refresh_failed").pipe(
          Effect.annotateLogs({ attempt: FIRST_ATTEMPT }),
        )
        yield* Effect.logWarning("refresh_failed").pipe(
          Effect.annotateLogs({ attempt: SECOND_ATTEMPT }),
        )

        expect(
          yield* (yield* CapturedLogs).named("refresh_failed"),
        ).toStrictEqual([
          {
            annotations: { attempt: FIRST_ATTEMPT },
            level: "Warn",
            message: "refresh_failed",
          },
          {
            annotations: { attempt: SECOND_ATTEMPT },
            level: "Warn",
            message: "refresh_failed",
          },
        ])
      }),
    )
  })
})

describe("a captured record's message", () => {
  test.layer(CapturedLogs.layer)((it: Tests) => {
    it.effect("joins the parts it was logged with", () =>
      Effect.gen(function* joinsParts() {
        expect.hasAssertions()

        yield* Effect.logInfo("plugin", "started")

        expect(yield* (yield* CapturedLogs).records).toStrictEqual([
          { annotations: {}, level: "Info", message: "plugin started" },
        ])
      }),
    )
  })
})
