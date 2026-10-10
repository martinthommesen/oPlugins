import {
  Context,
  Effect,
  HashMap,
  Layer,
  Option,
  Ref,
  Schema,
  Sink,
  Stream,
} from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import type { PlatformError } from "effect"
import fakeSecurity from "./fake-security.test-support.ts"

const FAKE_PID = 4243,
  /** A stream of bytes for a command's stdin. */
  InputStream = Schema.declare(
    (input): input is Stream.Stream<Uint8Array, PlatformError.PlatformError> =>
      Stream.isStream(input),
  ),
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
  codec = new TextEncoder(),
  /* A handle for a process that already exited with `code`, having printed `stdout`. */
  exitedHandle = (
    code: number,
    stdout: string,
  ): ChildProcessSpawner.ChildProcessHandle => {
    const output = Stream.make(codec.encode(stdout))

    return ChildProcessSpawner.makeHandle({
      all: output,
      exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(code)),
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Effect.succeed(false),
      kill: () => Effect.void,
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      stderr: Stream.empty,
      stdin: Sink.drain,
      stdout: output,
      unref: Effect.succeed(Effect.void),
    })
  }

/**
 * A macOS Keychain for tests: a `ChildProcessSpawner` that answers every
 * command as `security` would, from named files the test writes and reads.
 * The names are those of the old stand-in script: one file per service
 * holding its blob, `<service>.account`, `<service>.exit`, `dump`,
 * `<service>.drop`, `<service>.drop-once`, `<service>.flip`, and
 * `<service>.written-as`. Every invocation's argv is kept.
 */
class FakeKeychain extends Context.Service<
  FakeKeychain,
  {
    /** The argv of every `security` invocation, in order. */
    readonly argv: Effect.Effect<readonly (readonly string[])[]>
    readonly read: (name: string) => Effect.Effect<Option.Option<string>>
    readonly write: (name: string, content: string) => Effect.Effect<void>
  }
>()("oclaude/test/FakeKeychain") {
  /** The fake Keychain, and the spawner that reaches it. */
  public static readonly layer: Layer.Layer<
    ChildProcessSpawner.ChildProcessSpawner | FakeKeychain
  > = Layer.effectContext(
    Effect.gen(function* makeFakeKeychain() {
      const calls = yield* Ref.make<readonly (readonly string[])[]>([]),
        files = yield* Ref.make(HashMap.empty<string, string>()),
        spawner = ChildProcessSpawner.make(
          (command: { readonly _tag: string }) =>
            Effect.gen(function* spawn() {
              const decoded = yield* Schema.decodeUnknownEffect(SpawnedCommand)(
                  command,
                ).pipe(Effect.orDie),
                input = yield* Option.match(
                  Option.fromUndefinedOr(decoded.options.stdin),
                  {
                    onNone: () => Effect.succeed(""),
                    onSome: (stdin) =>
                      stdin.pipe(Stream.decodeText(), Stream.mkString),
                  },
                ),
                outcome = yield* Ref.update(calls, (all) => [
                  ...all,
                  decoded.args,
                ]).pipe(
                  Effect.andThen(
                    fakeSecurity.runSecurity(files, decoded.args, input),
                  ),
                )

              return exitedHandle(outcome.code, outcome.stdout)
            }),
        )

      return Context.make(FakeKeychain, {
        argv: Ref.get(calls),
        read: (name) => Ref.get(files).pipe(Effect.map(HashMap.get(name))),
        write: (name, content) => Ref.update(files, HashMap.set(name, content)),
      }).pipe(Context.add(ChildProcessSpawner.ChildProcessSpawner, spawner))
    }),
  )
}

export default FakeKeychain
