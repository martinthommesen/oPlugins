import { Effect, FileSystem, Option, Path } from "effect"
import { describe, expect, it } from "@effect/vitest"
import files from "./claude-code-file-store.test-support.ts"
import support from "./claude-code-stores.test-support.ts"

const ONE_ASSERTION = 1,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2

describe("guarded file write-back over bad storage", () => {
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
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("credentials file that cannot be read", () => {
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
      }).pipe(Effect.provide(support.layer)),
  )
})

describe("guarded file write-back temp files", () => {
  it.effect("leaves no temp file behind when the rename fails", () =>
    Effect.gen(function* run() {
      expect.assertions(TWO_ASSERTIONS)

      // A directory where the temp file would be renamed to.
      const fs = yield* FileSystem.FileSystem,
        holder = yield* files.credentialDir("old"),
        keepFile = fs.writeFileString(`${holder.path}/keep`, ""),
        refresh = support.onMac([], files.refreshFile(holder.dir)),
        result = yield* fs
          .remove(holder.path)
          .pipe(
            Effect.andThen(fs.makeDirectory(holder.path)),
            Effect.andThen(keepFile),
            Effect.andThen(refresh),
          ),
        temps = (yield* fs.readDirectory(holder.dir)).filter((name) =>
          name.endsWith(".tmp"),
        )

      expect(result).toBe("unavailable")
      expect(temps).toStrictEqual([])
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("guarded file write-back temp sweep", () => {
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
        expect(planted).toHaveLength(THREE_ASSERTIONS)
        // The stale temp blob goes; the fresh one and the unrelated file stay.
        expect(survivors).toStrictEqual([false, true, true])
      }).pipe(Effect.provide(support.layer)),
  )
})
