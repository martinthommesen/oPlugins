import { Effect, Option } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Vitest } from "@effect/vitest"
import faults from "./claude-code-file-faults.test-support.ts"
import files from "./claude-code-file-store.test-support.ts"
import support from "./claude-code-stores.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

type Records = Effect.Success<
  ReturnType<Effect.Success<typeof CapturedLogs>["named"]>
>

const CREDENTIALS_FILE = "/.credentials.json",
  FIRST = 0,
  TEMP_SUFFIX = ".tmp",
  /* The levels and field names of `records`, in order. */
  fieldNames = (records: Records): readonly (readonly unknown[])[] =>
    records.map((record) => [
      record.level,
      Object.keys(record.annotations).toSorted(),
    ]),
  /* The fields of the warnings among `records`. */
  warnings = (records: Records): readonly unknown[] =>
    records
      .filter((record) => record.level === "Warn")
      .map((record) => record.annotations),
  /*
   * Write refreshed tokens over a credentials file holding `old`, in a
   * config directory whose files fail per `failing`; what the write-back
   * said, the token the file holds after, and the records logged as `event`.
   */
  writeBackWith = Effect.fn("test.writeBackWith")(function* writeBackWith(
    failing: (dir: string) => Parameters<typeof faults.onMacWith>[typeof FIRST],
    event: string,
  ) {
    const holder = yield* files.credentialDir("old"),
      logs = yield* CapturedLogs,
      result = yield* faults.onMacWith(
        failing(holder.dir),
        files.refreshFile(holder.dir),
      ),
      stored = yield* files.fileToken(holder.path)

    return { records: yield* logs.named(event), result, stored }
  })

test.layer(support.layer)("credential temp files left behind", (it: Tests) => {
  it.effect("warns about a temp file holding tokens it can't delete", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const outcome = yield* writeBackWith(
        () => [
          faults.failAt("rename", CREDENTIALS_FILE, "EACCES"),
          faults.failAt("remove", TEMP_SUFFIX, "EBUSY"),
        ],
        "credential_temp_kept",
      )

      expect(outcome.result).toBe("unavailable")
      expect(outcome.stored).toStrictEqual(Option.some("old"))
      // The warning carries no path; the debug record does.
      expect(warnings(outcome.records)).toContainEqual({
        code: "EBUSY",
        source: "file",
        step: "remove",
      })
      expect(fieldNames(outcome.records)).toContainEqual([
        "Debug",
        ["configDir", "error", "path", "step"],
      ])
    }),
  )
})

test.layer(support.layer)("credential temp files renamed away", (it: Tests) => {
  it.effect("stays quiet about the temp file a landed write renamed", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      // Removing the renamed temp file finds it already gone.
      const outcome = yield* writeBackWith(() => [], "credential_temp_kept")

      expect(outcome.result).toBe("written")
      expect(outcome.records).toStrictEqual([])
    }),
  )
})

describe("credential directory sync", () => {
  test.layer(support.layer)((it: Tests) => {
    it.effect("warns about a failed sync, and still reports the write", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const outcome = yield* writeBackWith(
          (dir) => [faults.failAt("sync", dir, "EIO")],
          "credential_sync_failed",
        )

        expect(outcome.result).toBe("written")
        expect(outcome.stored).toStrictEqual(Option.some("new"))
        expect(warnings(outcome.records)).toStrictEqual([
          { code: "EIO", source: "file", step: "sync" },
        ])
        expect(fieldNames(outcome.records)).toStrictEqual([
          ["Warn", ["code", "source", "step"]],
          ["Debug", ["configDir", "error", "path", "step"]],
        ])
      }),
    )
  })

  test.layer(support.layer)((it: Tests) => {
    it.effect("stays quiet when the file system can't sync a directory", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const outcome = yield* writeBackWith(
          (dir) => [faults.failAt("sync", dir, "EINVAL")],
          "credential_sync_failed",
        )

        expect(outcome.result).toBe("written")
        expect(outcome.records).toStrictEqual([])
      }),
    )
  })
})

test.layer(support.layer)("credential temp sweep listing", (it: Tests) => {
  it.effect("warns when it can't list stale temps, and keeps the write", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const outcome = yield* writeBackWith(
        (dir) => [faults.failAt("readDirectory", dir, "EACCES")],
        "credential_sweep_failed",
      )

      expect(outcome.result).toBe("written")
      expect(outcome.stored).toStrictEqual(Option.some("new"))
      expect(warnings(outcome.records)).toStrictEqual([
        { code: "EACCES", source: "file", step: "list" },
      ])
      expect(fieldNames(outcome.records)).toStrictEqual([
        ["Warn", ["code", "source", "step"]],
        ["Debug", ["configDir", "error", "path", "step"]],
      ])
    }),
  )
})
