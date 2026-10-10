import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process"
import { Effect, Option, Stdio, Stream } from "effect"
import HeadlessSmokeError from "./headless-smoke-error.ts"
import type { PlatformError } from "effect"

/** One command to run, where, and how its environment differs from ours. */
interface Invocation {
  readonly args: readonly string[]
  readonly command: string
  readonly cwd: string
  /**
   * Merged over the inherited environment. An undefined value removes the
   * variable: Node's spawn skips undefined values.
   */
  readonly env: Readonly<Record<string, string | undefined>>
}

const SUCCESS = 0,
  TIMEOUT = "180 seconds",
  /* A process output stream, as text. */
  collect = (
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ): Effect.Effect<string, PlatformError.PlatformError> =>
    stream.pipe(Stream.decodeText(), Stream.mkString),
  /* How a command ended, for its failure message. */
  describe = (code: Option.Option<number>): string =>
    Option.match(code, {
      onNone: () => `timed out after ${TIMEOUT}`,
      onSome: (status) => `exited ${String(status)}`,
    }),
  /*
   * The exit code of `handle`, or none when it outlived the timeout and was
   * killed. Its output streams end when it does, so they stay readable.
   */
  exitWithin = (
    handle: ChildProcessSpawner.ChildProcessHandle,
  ): Effect.Effect<Option.Option<number>, PlatformError.PlatformError> =>
    handle.exitCode.pipe(
      Effect.timeoutOption(TIMEOUT),
      Effect.tap(
        Option.match({
          onNone: () => handle.kill(),
          onSome: () => Effect.void,
        }),
      ),
    ),
  /* Write `text` to stderr as it is. */
  printError = Effect.fn("Headless.printError")(function* printError(
    text: string,
  ) {
    const stdio = yield* Stdio.Stdio

    yield* Stream.make(text).pipe(Stream.run(stdio.stderr()))
  }),
  /*
   * Run a command and return its stdout. A command that fails or times out
   * has its output written to stderr before the failure.
   */
  run = Effect.fn("Headless.run")(function* run(invocation: Invocation) {
    const childProcesses = yield* ChildProcessSpawner.ChildProcessSpawner,
      handle = yield* childProcesses.spawn(
        ChildProcess.make(invocation.command, invocation.args, {
          cwd: invocation.cwd,
          env: invocation.env,
          extendEnv: true,
          stdin: "ignore",
        }),
      ),
      [stdout, stderr, code] = yield* Effect.all(
        [collect(handle.stdout), collect(handle.stderr), exitWithin(handle)],
        { concurrency: "unbounded" },
      )

    if (Option.exists(code, (status) => status === SUCCESS)) {
      return stdout
    }

    yield* printError(`${stdout}${stderr}`)

    return yield* HeadlessSmokeError.make({
      message: `${invocation.command} ${invocation.args.join(" ")} ${describe(code)}`,
    })
  }, Effect.scoped)

/** Running the commands the smoke test drives. */
export default Object.freeze({ printError, run })
