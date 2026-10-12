import { Effect, FileSystem, Option, Path } from "effect"
import type { Layer, Scope } from "effect"
import { expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import type { Vitest } from "@effect/vitest"
import faults from "./claude-code-file-faults.test-support.ts"
import files from "./claude-code-file-store.test-support.ts"
import support from "./claude-code-stores.test-support.ts"

type WriteResult = Effect.Success<
  ReturnType<ReturnType<typeof files.refreshFile>>
>

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof support.layer> | Scope.Scope
  >
}

const CREDENTIALS_FILE = "/.credentials.json",
  FIRST = 0,
  ONE_ASSERTION = 1,
  /** A second stale temp file, beside the one the planted set holds. */
  OTHER_STALE_TEMP = ".credentials.json.4.stale.tmp",
  PLANTED_FILES = 3,
  /** The stale temp file the planted set holds. */
  STALE_TEMP = ".credentials.json.1.stale.tmp",
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  /*
   * Write refreshed tokens over the credentials file in `dir`, with
   * `operation` on the planted stale temp failing with `code`.
   */
  refreshFailing = (
    dir: string,
    operation: "remove" | "stat",
    code: string,
  ): ReturnType<typeof faults.onMacWith<WriteResult, never>> =>
    faults.onMacWith(
      [faults.failAt(operation, STALE_TEMP, code)],
      files.refreshFile(dir),
    )

test.layer(support.layer)(
  "guarded file write-back over bad storage",
  (it: Tests) => {
    it.effect("reports malformed or missing storage as a failure", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)

        const dir = yield* support.sandbox,
          fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path,
          refreshBoth = support.onMac([], (stores) =>
            Effect.all([
              files.refreshFile(dir)(stores),
              files.refreshFile(path.join(dir, "missing"))(stores),
            ]),
          ),
          results = yield* fs
            .writeFileString(path.join(dir, ".credentials.json"), "not json")
            .pipe(Effect.andThen(refreshBoth))

        expect(results).toStrictEqual(["failed", "failed"])
      }),
    )
  },
)

test.layer(support.layer)(
  "credentials file that cannot be read",
  (it: Tests) => {
    it.effect(
      "reports an unreadable credentials file instead of 'no credentials'",
      () =>
        Effect.gen(function* run() {
          expect.assertions(TWO_ASSERTIONS)

          const dir = yield* support.sandbox,
            fs = yield* FileSystem.FileSystem,
            inDir = Option.some(dir),
            path = yield* Path.Path,
            underDir = Option.some(path.join(dir, "missing")),
            vetted = support.onMac([], (stores) =>
              Effect.all({
                failure: Effect.flip(stores.readSource(files.FILE, inDir)),
                missing: stores.readSource(files.FILE, underDir),
              }),
            ),
            views = yield* fs
              .makeDirectory(path.join(dir, ".credentials.json"))
              .pipe(Effect.andThen(vetted))

          expect(views.failure.message).toMatch(/EISDIR/u)
          expect(Option.isNone(views.missing)).toBe(true)
        }),
    )
  },
)

test.layer(support.layer)("guarded file write-back temp files", (it: Tests) => {
  it.effect("leaves no temp file behind when the rename fails", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      // The credentials file stays readable; only the rename over it fails.
      const fs = yield* FileSystem.FileSystem,
        holder = yield* files.credentialDir("old"),
        result = yield* faults.onMacWith(
          [faults.failAt("rename", CREDENTIALS_FILE, "EACCES")],
          files.refreshFile(holder.dir),
        ),
        temps = (yield* fs.readDirectory(holder.dir)).filter((name) =>
          name.endsWith(".tmp"),
        ),
        unswept = yield* (yield* CapturedLogs).named("credential_temp_kept")

      expect(result).toBe("unavailable")
      expect(temps).toStrictEqual([])
      expect(yield* files.fileToken(holder.path)).toStrictEqual(
        Option.some("old"),
      )
      // The temp file is removed, so nothing is reported.
      expect(unswept).toStrictEqual([])
    }),
  )
})

test.layer(support.layer)("guarded file write-back temp sweep", (it: Tests) => {
  it.effect(
    "sweeps temp files a killed process left behind, and only those",
    () =>
      Effect.gen(function* run() {
        expect.assertions(THREE_ASSERTIONS)

        const fs = yield* FileSystem.FileSystem,
          holder = yield* files.credentialDir("old"),
          planted = yield* files.agedTemps(holder.dir),
          result = yield* support.onMac([], files.refreshFile(holder.dir)),
          survivors = yield* Effect.forEach(
            planted,
            (temp) => fs.exists(temp),
            {
              concurrency: "unbounded",
            },
          )

        expect(result).toBe("written")
        expect(planted).toHaveLength(PLANTED_FILES)
        // The stale temp blob goes; the fresh one and the unrelated file stay.
        expect(survivors).toStrictEqual([false, true, true])
      }),
  )
})

test.layer(support.layer)(
  "guarded file write-back sweep removal failures",
  (it: Tests) => {
    it.effect("keeps sweeping after one stale temp can't be removed", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const fs = yield* FileSystem.FileSystem,
          holder = yield* files.credentialDir("old"),
          location = yield* Path.Path,
          logs = yield* CapturedLogs,
          other = location.join(holder.dir, OTHER_STALE_TEMP),
          planted = yield* files.agedTemps(holder.dir),
          result = yield* files
            .agedFile(other, files.STALE_TEMP_AGE_MS)
            .pipe(
              Effect.andThen(refreshFailing(holder.dir, "remove", "EACCES")),
            ),
          survivors = yield* Effect.all([
            fs.exists(planted[FIRST] ?? ""),
            fs.exists(other),
          ]),
          swept = yield* logs.named("credential_sweep_failed")

        // The landed write stays a success.
        expect(result).toBe("written")
        expect(survivors).toStrictEqual([true, false])
        expect(
          swept.map((record) => [record.level, record.annotations]),
        ).toContainEqual([
          "Warn",
          { code: "EACCES", source: "file", step: "remove" },
        ])
      }),
    )
  },
)

test.layer(support.layer)(
  "guarded file write-back sweep of gone files",
  (it: Tests) => {
    it.effect("stays quiet about a stale temp that is already gone", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const holder = yield* files.credentialDir("old"),
          logs = yield* CapturedLogs,
          result = yield* files
            .agedTemps(holder.dir)
            .pipe(Effect.andThen(refreshFailing(holder.dir, "stat", "ENOENT"))),
          swept = yield* logs.named("credential_sweep_failed")

        expect(result).toBe("written")
        expect(swept).toStrictEqual([])
      }),
    )
  },
)
