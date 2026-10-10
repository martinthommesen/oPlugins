import { Effect, FileSystem, Path } from "effect"
import { describe, expect, it } from "@effect/vitest"
import CapturedStderr from "./captured-stderr.test-support.ts"
import support from "./debug-log.test-support.ts"

const EPOCH = "1970-01-01T00:00:00.000Z",
  PERMISSION_MODULUS = 0o1000,
  PRIVATE_FILE = 0o600,
  STDERR_LINES = 2

describe("debug log when off", () => {
  it.effect("writes nothing when CLAUDE_AUTH_DEBUG is unset", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fs = yield* FileSystem.FileSystem,
        home = yield* support.sandbox

      yield* support.withLogger(home, "", (logger) =>
        logger.log("test_event", { key: "value" }),
      )

      expect(yield* fs.readDirectory(home)).toStrictEqual([])
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("treats the usual off values as disabled, not as a filename", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fs = yield* FileSystem.FileSystem,
        home = yield* support.sandbox

      yield* Effect.forEach(["0", "false", "no", "off", "OFF"], (value) =>
        support.withLogger(home, value, (logger) =>
          logger.log("test_event", {}),
        ),
      )

      expect(yield* fs.readDirectory(home)).toStrictEqual([])
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("debug log path validation", () => {
  it.effect("refuses a relative path and says why on stderr", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fs = yield* FileSystem.FileSystem,
        home = yield* support.sandbox,
        stderr = yield* CapturedStderr

      yield* support.withLogger(home, "debug.log", (logger) =>
        logger.log("test_event", {}),
      )

      expect(yield* stderr.text).toMatch(/absolute log file path/u)
      expect(yield* fs.readDirectory(home)).toStrictEqual([])
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("refuses to truncate any existing file it did not write", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fs = yield* FileSystem.FileSystem,
        home = yield* support.sandbox,
        path = (yield* Path.Path).join(home, ".credentials.json"),
        stderr = yield* CapturedStderr

      yield* fs.writeFileString(path, "important user data\n")
      yield* support.withLogger(home, path, (logger) =>
        logger.log("test_event", {}),
      )

      expect(yield* fs.readFileString(path)).toBe("important user data\n")
      expect(yield* stderr.text).toMatch(/not an oClaude log/u)
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("debug log file reuse", () => {
  it.effect("starts a file it wrote itself afresh", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const home = yield* support.sandbox,
        path = (yield* Path.Path).join(home, "reuse.log")

      yield* support.withLogger(home, path, (logger) =>
        logger.log("first_run", {}),
      )
      yield* support.withLogger(home, path, (logger) =>
        logger.log("second_run", {}),
      )

      expect(
        (yield* support.readRecords(path)).map((record) => record.event),
      ).toStrictEqual(["second_run"])
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("maps the on values to the default path", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const home = yield* support.sandbox,
        path = (yield* Path.Path).join(home, "opencode", "oclaude-debug.log")

      yield* Effect.forEach(["1", "true", "yes", "on"], (value) =>
        support.withLogger(home, value, (logger) => logger.log(value, {})),
      )

      expect(
        (yield* support.readRecords(path)).map((record) => record.event),
      ).toStrictEqual(["on"])
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("debug log records", () => {
  it.effect("writes JSON lines with a timestamp, the event, and fields", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const home = yield* support.sandbox,
        path = (yield* Path.Path).join(home, "nested", "dirs", "test.log")

      yield* support.withLogger(home, path, (logger) =>
        Effect.andThen(
          logger.log("event_one", { key: "value" }),
          logger.log("event_two", {}),
        ),
      )

      expect(yield* support.readRecords(path)).toStrictEqual([
        { event: "event_one", key: "value", ts: EPOCH },
        { event: "event_two", ts: EPOCH },
      ])
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("keeps the log as private as the credentials it describes", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fs = yield* FileSystem.FileSystem,
        home = yield* support.sandbox,
        path = (yield* Path.Path).join(home, "perms.log")

      yield* support.withLogger(home, path, (logger) =>
        logger.log("test_event", {}),
      )

      expect((yield* fs.stat(path)).mode % PERMISSION_MODULUS).toBe(
        PRIVATE_FILE,
      )
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("debug log warnings", () => {
  it.effect("reach stderr even with the debug log off, once per kind", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const home = yield* support.sandbox,
        stderr = yield* CapturedStderr

      yield* support.withLogger(home, "", (logger) =>
        Effect.forEach(
          ["writeback_failed", "writeback_failed", "lock_degraded"],
          (event) => logger.warn(event, { warning: `${event} happened` }),
        ),
      )

      expect(yield* stderr.text).toBe(
        "oClaude: writeback_failed happened\noClaude: lock_degraded happened\n",
      )
    }).pipe(Effect.provide(support.layer)),
  )
})

describe("debug log warning records", () => {
  it.effect("also land in the debug log with their fields", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const home = yield* support.sandbox,
        path = (yield* Path.Path).join(home, "warn.log")

      yield* support.withLogger(home, path, (logger) =>
        logger.warn("writeback_failed", { source: "file", warning: "lost" }),
      )

      expect(yield* support.readRecords(path)).toStrictEqual([
        {
          event: "writeback_failed",
          source: "file",
          ts: EPOCH,
          warning: "lost",
        },
      ])
    }).pipe(Effect.provide(support.layer)),
  )

  it.effect("disables a log that stopped accepting writes and says so", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const fs = yield* FileSystem.FileSystem,
        home = yield* support.sandbox,
        logs = (yield* Path.Path).join(home, "logs"),
        path = (yield* Path.Path).join(logs, "gone.log"),
        stderr = yield* CapturedStderr

      yield* support.withLogger(home, path, (logger) =>
        fs
          .remove(logs, { recursive: true })
          .pipe(
            Effect.andThen(logger.log("first", {})),
            Effect.andThen(fs.makeDirectory(logs)),
            Effect.andThen(logger.log("second", {})),
          ),
      )

      expect(yield* fs.exists(path)).toBe(false)
      expect(yield* stderr.text).toMatch(/debug log disabled/u)
      expect((yield* stderr.text).split("\n")).toHaveLength(STDERR_LINES)
    }).pipe(Effect.provide(support.layer)),
  )
})
