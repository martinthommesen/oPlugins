import { ChildProcess, ChildProcessSpawner } from "effect/process"
import { Data, Effect, Fiber, Option, Ref, Scope, Stdio, Stream } from "effect"
import type { Exit, PlatformError } from "effect"
import HostTestError from "./host-test-error.ts"

/** One command to run, its directory, and its changes to the environment. */
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

/** How a command ended. */
type Ending = Data.TaggedEnum<{
  /** It exited with `code` and closed its output. */
  Exited: { readonly code: number }
  /** It could not be waited for or read, such as when a signal killed it. */
  Failed: { readonly reason: string }
  /**
   * It outlived the timeout. `unstopped` says why stopping it could not be
   * confirmed; none means it stopped.
   */
  TimedOut: { readonly unstopped: Option.Option<string> }
}>

const Endings = Data.taggedEnum<Ending>(),
  /* How long a command that ignores SIGTERM gets before SIGKILL. */
  KILL_GRACE = "3 seconds",
  /*
   * How long releasing a command's process may take. The release signals
   * any process still in the group, waits `KILL_GRACE`, then SIGKILLs it
   * and waits up to a second more.
   */
  RELEASE_LIMIT = "5 seconds",
  /* How long stopping a command that timed out may take, `KILL_GRACE` included. */
  STOP_LIMIT = "5 seconds",
  SUCCESS = 0,
  TIMEOUT = "180 seconds",
  /*
   * Close `scope` within `RELEASE_LIMIT`. A release that outlasts it keeps
   * running detached, so it cannot hold the host test.
   */
  close = <Value, Failure>(
    scope: Scope.Closeable,
    exit: Exit.Exit<Value, Failure>,
  ): Effect.Effect<void> =>
    Scope.close(scope, exit).pipe(
      Effect.forkDetach(),
      Effect.flatMap((fiber) => Fiber.await(fiber)),
      Effect.timeoutOption(RELEASE_LIMIT),
      Effect.asVoid,
    ),
  /* Run `effect` in a scope that `close` releases. */
  closing = <Value, Failure, Services>(
    effect: Effect.Effect<Value, Failure, Services>,
  ): Effect.Effect<Value, Failure, Exclude<Services, Scope.Scope>> =>
    Scope.make().pipe(
      Effect.flatMap((scope) =>
        effect.pipe(
          Scope.provide(scope),
          Effect.onExit((exit) => close(scope, exit)),
        ),
      ),
    ),
  /* Append a process output stream, as text, to `sink` as it arrives. */
  collect = (
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
    sink: Ref.Ref<string>,
  ): Effect.Effect<void, PlatformError.PlatformError> =>
    stream.pipe(
      Stream.decodeText(),
      Stream.runForEach((text) =>
        Ref.update(sink, (sofar) => `${sofar}${text}`),
      ),
    ),
  /* How a command ended, for its failure message. */
  describe = (ending: Ending): string =>
    Endings.$match(ending, {
      Exited: ({ code }) => `exited ${String(code)}`,
      Failed: ({ reason }) => `failed: ${reason}`,
      TimedOut: ({ unstopped }) =>
        Option.match(unstopped, {
          onNone: () => `timed out after ${TIMEOUT}`,
          onSome: (reason) => `timed out after ${TIMEOUT}; ${reason}`,
        }),
    }),
  /*
   * Stop a command that timed out: SIGTERM, then SIGKILL after
   * `KILL_GRACE`. Succeeds with why stopping it is not confirmed, or none
   * when it stopped.
   */
  halt = (
    handle: ChildProcessSpawner.ChildProcessHandle,
  ): Effect.Effect<Option.Option<string>> =>
    handle.kill({ forceKillAfter: KILL_GRACE }).pipe(
      Effect.andThen(Effect.succeedNone),
      Effect.catchTag(
        "PlatformError",
        (failure: { readonly message: string }) =>
          Effect.succeedSome(`stopping it failed: ${failure.message}`),
      ),
      Effect.timeoutOrElse({
        duration: STOP_LIMIT,
        orElse: () =>
          Effect.succeedSome(`it did not stop within ${STOP_LIMIT}`),
      }),
    ),
  /* Whether a command ended with a successful exit. */
  isSuccess = (ending: Ending): boolean =>
    Endings.$match(ending, {
      Exited: ({ code }) => code === SUCCESS,
      Failed: () => false,
      TimedOut: () => false,
    }),
  /*
   * How `handle` ends, its output collected into `stdout` and `stderr` as
   * it arrives. The timeout covers the end of both output streams, which a
   * descendant can hold open after the command exits, and the exit.
   */
  observe = (
    handle: ChildProcessSpawner.ChildProcessHandle,
    stdout: Ref.Ref<string>,
    stderr: Ref.Ref<string>,
  ): Effect.Effect<Ending> =>
    Effect.all(
      [collect(handle.stdout, stdout), collect(handle.stderr, stderr)],
      {
        concurrency: "unbounded",
      },
    ).pipe(
      Effect.andThen(handle.exitCode),
      Effect.map((code) => Endings.Exited({ code })),
      Effect.catchTag(
        "PlatformError",
        (failure: { readonly message: string }) =>
          Effect.succeed(Endings.Failed({ reason: failure.message })),
      ),
      Effect.timeoutOrElse({
        duration: TIMEOUT,
        orElse: () =>
          halt(handle).pipe(
            Effect.map((unstopped) => Endings.TimedOut({ unstopped })),
          ),
      }),
    ),
  /* Write `text` to stderr as it is. */
  printError = Effect.fn("HostTest.printError")(function* printError(
    text: string,
  ) {
    const stdio = yield* Stdio.Stdio

    yield* Stream.make(text).pipe(Stream.run(stdio.stderr()))
  }),
  /*
   * Run a command and return its stdout. When the command fails or times
   * out, write the output it gave to stderr, then fail.
   */
  run = Effect.fn("HostTest.run")(function* run(invocation: Invocation) {
    const childProcesses = yield* ChildProcessSpawner.ChildProcessSpawner,
      handle = yield* childProcesses.spawn(
        ChildProcess.make(invocation.command, invocation.args, {
          cwd: invocation.cwd,
          env: invocation.env,
          extendEnv: true,
          forceKillAfter: KILL_GRACE,
          stdin: "ignore",
        }),
      ),
      stderr = yield* Ref.make(""),
      stdout = yield* Ref.make(""),
      verdict = yield* observe(handle, stdout, stderr),
      [output, errors] = yield* Effect.all([Ref.get(stdout), Ref.get(stderr)])

    if (isSuccess(verdict)) {
      return output
    }

    yield* printError(`${output}${errors}`)

    return yield* HostTestError.make({
      message: `${invocation.command} ${invocation.args.join(" ")} ${describe(verdict)}. Read its output above for the cause.`,
    })
  }, closing)

/** Running the commands the host test drives. */
/** @internal */
export default Object.freeze({ Endings, describe, printError, run })
