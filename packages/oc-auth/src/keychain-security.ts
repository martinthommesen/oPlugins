import { ChildProcess, ChildProcessSpawner } from "effect/process"
import type { Duration, PlatformError } from "effect"
import { Effect, Option, Stream } from "effect"
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
   * The failure of `run`. The message names the subcommand but never its
   * arguments, which can carry a credential blob.
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
   * kills it; a process that could not start or was killed by a signal has
   * no exit status to classify.
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
        PlatformError: (cause: { readonly message: string }) =>
          Effect.fail(failure(run, "exit_unknown", cause.message)),
        TimeoutError: () => Effect.fail(failure(run, "timeout", "")),
      }),
    )

/** Running the macOS `security` tool. */
/** @internal */
export default Object.freeze({ security })
