import {
  Deferred,
  Duration,
  Effect,
  Option,
  PlatformError,
  Stream,
} from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { ChildProcessSpawner } from "effect/process"
import FakeProcess from "./fake-process.test-support.ts"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import command from "./command.ts"

/** The fake process, its spawner, and its stderr. */
type Fake = Layer.Success<ReturnType<typeof FakeProcess.layer>>

/** The `it` of a `test.layer` block: `it.effect`, given the fake process. */
interface Tests {
  readonly effect: Vitest.Test<Fake | Scope.Scope>
}

const CLEAN_EXIT = 0,
  EXITED = Effect.succeed(ChildProcessSpawner.ExitCode(CLEAN_EXIT)),
  { Endings } = command,
  FAILURE = 1,
  INVOCATION = { args: ["pack"], command: "pnpm", cwd: "/work", env: {} },
  JUST_SHORT = "4 seconds",
  KILL_GRACE = "3 seconds",
  KILL_GRACE_MS = 3000,
  ONE_SECOND = "1 second",
  STOP_LIMIT = "5 seconds",
  TIMEOUT = "180 seconds",
  bytes = new TextEncoder(),
  /* A stream that gives `text`, then stays open. */
  held = (
    text: string,
  ): Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
    Stream.concat(Stream.make(bytes.encode(text)), Stream.never),
  /*
   * A process that prints "built" and "warned", then never exits on its
   * own. It answers a kill with `kill` and its release with `release`.
   */
  hung = (
    kill: (
      grace: Option.Option<number>,
    ) => Effect.Effect<void, PlatformError.PlatformError>,
    release: Effect.Effect<void>,
  ): Layer.Layer<Fake> =>
    FakeProcess.layer({
      exitCode: Effect.never,
      kill,
      release,
      stderr: held("warned"),
      stdout: held("built"),
    }),
  /* A process that exits 0 while a descendant holds its stdout open. */
  leaky = FakeProcess.layer({
    exitCode: EXITED,
    kill: () => Effect.void,
    release: Effect.void,
    stderr: Stream.empty,
    stdout: held("built"),
  }),
  /* The failure message of `pnpm pack`, given how it ended. */
  messageFor = (ending: string): string =>
    `pnpm pack ${ending}. Read its output above for the cause.`,
  /* A platform failure of the child process's `method`. */
  platformFailure = (
    method: string,
    description: string,
  ): PlatformError.PlatformError =>
    PlatformError.badArgument({ description, method, module: "ChildProcess" }),
  /* A hung process whose kill fails. */
  refusing = hung(
    () => Effect.fail(platformFailure("kill", "operation not permitted")),
    Effect.void,
  ),
  /* A stream that gives `text`, then ends. */
  said = (text: string): Stream.Stream<Uint8Array> =>
    Stream.make(bytes.encode(text)),
  /* A process a signal killed after it printed "built" and "warned". */
  signalled = FakeProcess.layer({
    exitCode: Effect.fail(
      platformFailure("exitCode", "Process interrupted by SIGKILL"),
    ),
    kill: () => Effect.void,
    release: Effect.void,
    stderr: said("warned"),
    stdout: said("built"),
  }),
  /*
   * Start the command in the background. The deferred completes with the
   * message it fails with, or its stdout.
   */
  started = Effect.gen(function* started() {
    const done = yield* Deferred.make<string>()

    yield* command.run(INVOCATION).pipe(
      Effect.match({
        onFailure: (failure: { readonly message: string }) => failure.message,
        onSuccess: (stdout) => stdout,
      }),
      Effect.flatMap((text) => Deferred.succeed(done, text)),
      Effect.forkChild,
    )

    return done
  }),
  /* A hung process that ignores SIGTERM and dies to SIGKILL after its grace. */
  stubborn = hung(
    (grace) =>
      Option.match(grace, {
        onNone: () => Effect.never,
        onSome: (millis) => Effect.sleep(Duration.millis(millis)),
      }),
    Effect.void,
  ),
  /* A hung process that nothing stops, not even its release. */
  stuck = hung(() => Effect.never, Effect.never),
  /* A process that printed "built" and "warned", then exited 0. */
  succeeding = FakeProcess.layer({
    exitCode: EXITED,
    kill: () => Effect.void,
    release: Effect.void,
    stderr: said("warned"),
    stdout: said("built"),
  })

describe("a failed command's description", () => {
  test("names the exit code", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const ending = Endings.Exited({ code: FAILURE })

    expect(command.describe(ending)).toBe("exited 1")
  })

  test(
    "names the timeout of a command that was killed",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const ending = Endings.TimedOut({ unstopped: Option.none() })

      expect(command.describe(ending)).toBe("timed out after 180 seconds")
    },
  )
})

describe("a command that ignores SIGTERM", () => {
  test.layer(stubborn)((it: Tests) => {
    it.effect("is killed after a short grace, its output kept", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const done = yield* started,
          fake = yield* FakeProcess

        yield* TestClock.adjust(TIMEOUT)
        yield* TestClock.adjust(KILL_GRACE)

        expect(yield* Deferred.await(done)).toBe(
          messageFor("timed out after 180 seconds"),
        )
        expect(yield* fake.printed).toBe("builtwarned")
        expect(yield* fake.kills).toStrictEqual([Option.some(KILL_GRACE_MS)])
        expect(yield* fake.commands).toStrictEqual([Option.some(KILL_GRACE_MS)])
      }),
    )
  })
})

describe("a command that cannot be stopped", () => {
  test.layer(stuck)((it: Tests) => {
    it.effect("is given up on after the cleanup allowance", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const done = yield* started,
          fake = yield* FakeProcess

        yield* TestClock.adjust(TIMEOUT)
        yield* TestClock.adjust(STOP_LIMIT)
        yield* TestClock.adjust(JUST_SHORT)

        expect(yield* Deferred.isDone(done)).toBe(false)

        yield* TestClock.adjust(ONE_SECOND)

        expect(yield* Deferred.await(done)).toBe(
          messageFor(
            "timed out after 180 seconds; it did not stop within 5 seconds",
          ),
        )
        expect(yield* fake.printed).toBe("builtwarned")
      }),
    )
  })
})

describe("a command whose kill fails", () => {
  test.layer(refusing)((it: Tests) => {
    it.effect("reports the failure alongside the timeout", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const done = yield* started,
          fake = yield* FakeProcess

        yield* TestClock.adjust(TIMEOUT)

        expect(yield* Deferred.await(done)).toBe(
          messageFor(
            "timed out after 180 seconds; stopping it failed: ChildProcess.kill: operation not permitted",
          ),
        )
        expect(yield* fake.printed).toBe("builtwarned")
      }),
    )
  })
})

describe("a command whose descendant holds its output open", () => {
  test.layer(leaky)((it: Tests) => {
    it.effect("times out with the output it gave", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const done = yield* started,
          fake = yield* FakeProcess

        yield* TestClock.adjust(TIMEOUT)

        expect(yield* Deferred.await(done)).toBe(
          messageFor("timed out after 180 seconds"),
        )
        expect(yield* fake.printed).toBe("built")
      }),
    )
  })
})

describe("a command a signal killed", () => {
  test.layer(signalled)((it: Tests) => {
    it.effect("fails with the signal and the output it gave", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const done = yield* started,
          fake = yield* FakeProcess

        expect(yield* Deferred.await(done)).toBe(
          messageFor(
            "failed: ChildProcess.exitCode: Process interrupted by SIGKILL",
          ),
        )
        expect(yield* fake.printed).toBe("builtwarned")
      }),
    )
  })
})

describe("a command that exits 0", () => {
  test.layer(succeeding)((it: Tests) => {
    it.effect("returns its stdout and prints nothing", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const done = yield* started,
          fake = yield* FakeProcess

        expect(yield* Deferred.await(done)).toBe("built")
        expect(yield* fake.printed).toBe("")
      }),
    )
  })
})
