import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Duration, PlatformError } from "effect"
import { Effect, Match, Option, Stream } from "effect"
import Environment from "./environment.ts"
import KeychainSecurityError from "./keychain-security-error.ts"

/** One run of the `security` tool. */
interface SecurityRun {
  /** The arguments, the subcommand first. */
  readonly args: readonly string[]
  /** Written to stdin, which is then closed. */
  readonly input: Option.Option<string>
  /** How long the run may take before it is killed. */
  readonly timeout: Duration.Input
}

const EXIT_DENIED = 128,
  EXIT_LOCKED = 36,
  EXIT_NOT_FOUND = 44,
  FIRST = 0,
  /*
   * How long a process that ignored SIGTERM gets before SIGKILL, so a hung
   * `security` cannot outlive its timeout by much.
   */
  KILL_GRACE = "1 second",
  /** `security` exit statuses with a known meaning. */
  KNOWN_EXITS: ReadonlyMap<number, string> = new Map([
    [EXIT_LOCKED, "locked"],
    [EXIT_NOT_FOUND, "not_found"],
    [EXIT_DENIED, "denied"],
  ]),
  SUCCESS = 0,
  codec = new TextEncoder(),
  /* A process output stream, as text. */
  collect = (
    stream: Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ): Effect.Effect<string, PlatformError.PlatformError> =>
    stream.pipe(Stream.decodeText(), Stream.mkString),
  /* The command for `run`, with its input on stdin when it has any. */
  commandFor = (
    binary: string,
    run: SecurityRun,
  ): ChildProcess.StandardCommand =>
    Option.match(run.input, {
      onNone: () =>
        ChildProcess.make(binary, run.args, { forceKillAfter: KILL_GRACE }),
      onSome: (text) =>
        ChildProcess.make(binary, run.args, {
          forceKillAfter: KILL_GRACE,
          stdin: Stream.make(codec.encode(text)),
        }),
    }),
  /*
   * The failure of `run`. The message names the subcommand and adds only
   * what `security` wrote to stderr, never the arguments, which can carry a
   * credential blob.
   */
  failure = (
    run: SecurityRun,
    errorType: string,
    stderr: string,
  ): KeychainSecurityError =>
    KeychainSecurityError.make({
      errorType,
      message: [
        `security ${run.args[FIRST] ?? ""} failed (${errorType})`,
        stderr,
      ]
        .filter((part) => part !== "")
        .join(": "),
      stderr,
    }),
  /*
   * The failure type of a process failure, from the operation that failed:
   * the process could not start, ended without an exit status, or its
   * output or input broke. Only the operation's name is read. The platform
   * error's message and cause quote the whole command line, and a write too
   * long for interactive mode passes the credentials, hex-encoded, as an
   * argument.
   */
  processFailureType = (method: string): string =>
    Match.value(method).pipe(
      Match.when("spawn", () => "start_failed"),
      Match.when("exitCode", () => "no_exit_status"),
      Match.when(
        (operation) => operation.startsWith("fromReadable"),
        () => "output_failed",
      ),
      Match.when(
        (operation) => operation.startsWith("fromWritable"),
        () => "input_failed",
      ),
      Match.orElse(() => "process_failed"),
    ),
  /* Run `security` once and collect its stdout; a non-zero exit fails. */
  runOnce = Effect.fn("KeychainSecurity.runOnce")(function* runOnce(
    run: SecurityRun,
  ) {
    const childProcesses = yield* ChildProcessSpawner.ChildProcessSpawner,
      environment = yield* Environment,
      handle = yield* childProcesses.spawn(
        commandFor(environment.variables.securityBinary, run),
      ),
      [stdout, stderr, code] = yield* Effect.all(
        [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
        { concurrency: "unbounded" },
      )

    if (code === SUCCESS) {
      return stdout
    }

    return yield* failure(
      run,
      KNOWN_EXITS.get(code) ?? `exit_${String(code)}`,
      stderr.trim(),
    )
  }, Effect.scoped),
  /*
   * Run the macOS `security` tool without blocking the plugin. A timeout
   * kills it. A process that could not start, was killed by a signal, or
   * whose output broke has no exit status to classify, so it fails with the
   * kind of process failure alone.
   */
  security = (
    run: SecurityRun,
  ): Effect.Effect<
    string,
    KeychainSecurityError,
    ChildProcessSpawner.ChildProcessSpawner | Environment
  > =>
    runOnce(run).pipe(
      Effect.timeout(run.timeout),
      Effect.catchTags({
        PlatformError: (cause: {
          readonly reason: { readonly method: string }
        }) =>
          Effect.fail(
            failure(run, processFailureType(cause.reason.method), ""),
          ),
        TimeoutError: () => Effect.fail(failure(run, "timeout", "")),
      }),
    )

/** Running the macOS `security` tool. */
/** @internal */
export default Object.freeze({ security })
