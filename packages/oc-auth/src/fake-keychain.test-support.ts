import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  PlatformError,
  Ref,
  Schema,
  Sink,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/process"
import fakeSecurity from "./fake-security.test-support.ts"

/** What a fake process reports: how it exits, and what it prints. */
interface Ending {
  readonly exitCode: Effect.Effect<
    ChildProcessSpawner.ExitCode,
    PlatformError.PlatformError
  >
  readonly stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
}

type Files = Parameters<typeof fakeSecurity.runSecurity>[typeof FIRST]

const FAKE_PID = 4243,
  FIRST = 0,
  /** A stream of bytes for a command's stdin. */
  InputStream = Schema.declare(
    (input): input is Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
      Stream.isStream(input),
  ),
  /**
   * The file that makes every `add-generic-password` run on argv fail as a
   * process: `spawn` cannot start, `signal` ends without an exit status, and
   * `output` cannot read its output.
   */
  NO_ERROR = 0,
  PROCESS_FAILURE = "process-failure",
  /** How a process that succeeded exits. */
  SUCCEEDED = Effect.succeed(ChildProcessSpawner.ExitCode(NO_ERROR)),
  /**
   * The parts of a spawned command the fake reads. `ChildProcess.Command`
   * cannot be a parameter type under the readonly-parameter rule, so the
   * spawner takes the command as data and decodes it here.
   */
  SpawnedCommand = Schema.Struct({
    args: Schema.Array(Schema.String),
    options: Schema.Struct({
      stdin: Schema.optionalKey(InputStream),
    }),
  }),
  /* A handle for a process that ends as `ending` says. */
  asHandle = (ending: Ending): ChildProcessSpawner.ChildProcessHandle =>
    ChildProcessSpawner.makeHandle({
      all: ending.stdout,
      exitCode: ending.exitCode,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      stderr: Stream.empty,
      stdin: Sink.drain,
      stdout: ending.stdout,
      unref: Effect.succeed(Effect.void),
    }),
  codec = new TextEncoder(),
  /*
   * The error Node's spawner raises when `method` fails: like the real one,
   * its message and its cause quote the whole command line.
   */
  commandLineError = (
    method: string,
    args: readonly string[],
  ): PlatformError.PlatformError => {
    const commandLine = `/usr/bin/security ${args.join(" ")}`

    return PlatformError.badArgument({
      cause: new Error(`${method} failed: ${commandLine}`),
      description: commandLine,
      method,
      module: "ChildProcess",
    })
  },
  /* A handle for a process that already exited with `code`, having printed `stdout`. */
  exitedHandle = (
    code: number,
    stdout: string,
  ): ChildProcessSpawner.ChildProcessHandle =>
    asHandle({
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      stdout: Stream.make(codec.encode(stdout)),
    }),
  /* A process that fails the way `kind` names, running `args`. */
  failingProcess = (
    kind: string,
    args: readonly string[],
  ): Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError
  > => {
    const exitError = commandLineError("exitCode", args),
      outputError = commandLineError("fromReadable(stdout)", args),
      spawnError = commandLineError("spawn", args)

    if (kind === "spawn") {
      return Effect.fail(spawnError)
    }

    if (kind === "output") {
      return Effect.succeed(
        asHandle({ exitCode: SUCCEEDED, stdout: Stream.fail(outputError) }),
      )
    }

    return Effect.succeed(
      asHandle({ exitCode: Effect.fail(exitError), stdout: Stream.empty }),
    )
  },
  /* The process failure forced on `args`, if any: argv writes only. */
  forcedFailure = (
    files: Files,
    args: readonly string[],
  ): Effect.Effect<Option.Option<string>> =>
    Ref.get(files).pipe(
      Effect.map(HashMap.get(PROCESS_FAILURE)),
      Effect.map(Option.filter(() => args[FIRST] === "add-generic-password")),
    ),
  /* Run one spawned `command` against `files`, recording its argv in `calls`. */
  spawnFake = Effect.fn("FakeKeychain.spawn")(function* spawnFake(
    files: Files,
    calls: Ref.Ref<readonly (readonly string[])[]>,
    command: { readonly _tag: string },
  ) {
    const decoded = yield* Schema.decodeUnknownEffect(SpawnedCommand)(
        command,
      ).pipe(Effect.orDie),
      forced = yield* forcedFailure(files, decoded.args),
      input = yield* Option.match(
        Option.fromUndefinedOr(decoded.options.stdin),
        {
          onNone: () => Effect.succeed(""),
          onSome: (stdin) => stdin.pipe(Stream.decodeText(), Stream.mkString),
        },
      )

    yield* Ref.update(calls, (all) => [...all, decoded.args])

    return yield* Option.match(forced, {
      onNone: () =>
        fakeSecurity
          .runSecurity(files, decoded.args, input)
          .pipe(
            Effect.map((outcome) => exitedHandle(outcome.code, outcome.stdout)),
          ),
      onSome: (kind) => failingProcess(kind, decoded.args),
    })
  })

/**
 * A macOS Keychain for tests: a `ChildProcessSpawner` that answers every
 * command as `security` would, from named files the test writes and reads.
 * `fake-security.test-support.ts` says what each file means, and the
 * `process-failure` file makes argv writes fail as processes.
 */
class FakeKeychain extends Context.Service<
  FakeKeychain,
  {
    /** The argv of every `security` invocation, in order. */
    readonly argv: Effect.Effect<readonly (readonly string[])[]>
    /** The content of the file `name`, or none when there is no such file. */
    readonly read: (name: string) => Effect.Effect<Option.Option<string>>
    /** Write `content` to the file `name`. */
    readonly write: (name: string, content: string) => Effect.Effect<void>
  }
>()("@martinthommesen/oc-auth/fake-keychain.test-support/FakeKeychain") {
  /** The process failures the `process-failure` file can name. */
  public static readonly processFailures = [
    "spawn",
    "signal",
    "output",
  ] as const

  /** The file that names the process failure argv writes end in. */
  public static readonly processFailureFile = PROCESS_FAILURE

  /** The fake Keychain, and the spawner that reaches it. */
  public static readonly layer: Layer.Layer<
    ChildProcessSpawner.ChildProcessSpawner | FakeKeychain
  > = Layer.effectContext(
    Effect.gen(function* makeFakeKeychain() {
      const calls = yield* Ref.make<readonly (readonly string[])[]>([]),
        files = yield* Ref.make(HashMap.empty<string, string>()),
        spawner = ChildProcessSpawner.make(
          (command: { readonly _tag: string }) =>
            spawnFake(files, calls, command),
        )

      return Context.make(FakeKeychain, {
        argv: Ref.get(calls),
        read: (name) => Ref.get(files).pipe(Effect.map(HashMap.get(name))),
        write: (name, content) => Ref.update(files, HashMap.set(name, content)),
      }).pipe(Context.add(ChildProcessSpawner.ChildProcessSpawner, spawner))
    }),
  )
}

/** @internal */
export default FakeKeychain
