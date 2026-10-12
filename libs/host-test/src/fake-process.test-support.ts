import {
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Sink,
  Stdio,
  Stream,
} from "effect"
import type { ChildProcess } from "effect/process"
import { ChildProcessSpawner } from "effect/process"
import type { PlatformError } from "effect"

/** How the one process the fake spawns behaves. */
interface Behavior {
  readonly exitCode: Effect.Effect<
    ChildProcessSpawner.ExitCode,
    PlatformError.PlatformError
  >
  /**
   * How it answers a kill, given the kill's SIGKILL grace in milliseconds,
   * or none when the kill has none.
   */
  readonly kill: (
    grace: Option.Option<number>,
  ) => Effect.Effect<void, PlatformError.PlatformError>
  /** How releasing its scope goes. */
  readonly release: Effect.Effect<void>
  readonly stderr: Stream.Stream<Uint8Array, PlatformError.PlatformError>
  readonly stdout: Stream.Stream<Uint8Array, PlatformError.PlatformError>
}

const FAKE_PID = 4243,
  codec = new TextDecoder(),
  /* One item written to the fake stderr, as text. */
  decoded = (item: string | Uint8Array): string => {
    if (Predicate.isString(item)) {
      return item
    }

    return codec.decode(item)
  },
  /* A grace period, in milliseconds. */
  graceOf = (grace: Duration.Input | undefined): Option.Option<number> =>
    Option.fromUndefinedOr(grace).pipe(
      Option.map((input) => Duration.toMillis(input)),
    ),
  /* The handle of the process `behavior` describes; its kills go to `kills`. */
  handleFor = (
    behavior: Behavior,
    kills: Ref.Ref<readonly Option.Option<number>[]>,
  ): ChildProcessSpawner.ChildProcessHandle =>
    ChildProcessSpawner.makeHandle({
      all: Stream.merge(behavior.stdout, behavior.stderr),
      exitCode: behavior.exitCode,
      getInputFd: () => Sink.drain,
      getOutputFd: () => Stream.empty,
      isRunning: Effect.succeed(true),
      kill: (options) => {
        const grace = Option.fromUndefinedOr(options).pipe(
          Option.flatMap((given) => graceOf(given.forceKillAfter)),
        )

        return Ref.update(kills, (all) => [...all, grace]).pipe(
          Effect.andThen(behavior.kill(grace)),
        )
      },
      pid: ChildProcessSpawner.ProcessId(FAKE_PID),
      stderr: behavior.stderr,
      stdin: Sink.drain,
      stdout: behavior.stdout,
      unref: Effect.succeed(Effect.void),
    }),
  /*
   * A spawner whose every process behaves as `behavior` says. It records
   * each command's grace in `commands` and each kill's in `kills`. The host
   * test spawns only standard commands, which `ChildProcess.make` builds.
   */
  spawnerFor = (
    behavior: Behavior,
    commands: Ref.Ref<readonly Option.Option<number>[]>,
    kills: Ref.Ref<readonly Option.Option<number>[]>,
  ): ChildProcessSpawner.ChildProcessSpawner["Service"] =>
    ChildProcessSpawner.make((command: ChildProcess.StandardCommand) =>
      Ref.update(commands, (all) => [
        ...all,
        graceOf(command.options.forceKillAfter),
      ]).pipe(
        Effect.andThen(Effect.addFinalizer(() => behavior.release)),
        Effect.as(handleFor(behavior, kills)),
      ),
    ),
  /* A `Stdio` that appends what is written to its stderr to `printed`. */
  stdioFor = (printed: Ref.Ref<string>): Stdio.Stdio =>
    Stdio.make({
      args: Effect.succeed([]),
      stderr: () =>
        Sink.forEachArray((items) =>
          Ref.update(
            printed,
            (sofar) => `${sofar}${items.map((item) => decoded(item)).join("")}`,
          ),
        ),
      stdin: Stream.empty,
      stdout: () => Sink.drain,
    })

/**
 * A `ChildProcessSpawner` whose process behaves as a test says, and a
 * `Stdio` whose stderr the test reads.
 */
class FakeProcess extends Context.Service<
  FakeProcess,
  {
    /** The SIGKILL grace of each spawned command, in milliseconds. */
    readonly commands: Effect.Effect<readonly Option.Option<number>[]>
    /** The SIGKILL grace of each kill, in milliseconds, in order. */
    readonly kills: Effect.Effect<readonly Option.Option<number>[]>
    /** Everything written to stderr. */
    readonly printed: Effect.Effect<string>
  }
>()("@oc-lib/host-test/fake-process.test-support/FakeProcess") {
  /* The fake, its spawner, and its stderr, for a process like `behavior`. */
  public static readonly layer = (
    behavior: Behavior,
  ): Layer.Layer<
    ChildProcessSpawner.ChildProcessSpawner | FakeProcess | Stdio.Stdio
  > =>
    Layer.effectContext(
      Effect.gen(function* makeFakeProcess() {
        const commands = yield* Ref.make<readonly Option.Option<number>[]>([]),
          kills = yield* Ref.make<readonly Option.Option<number>[]>([]),
          printed = yield* Ref.make("")

        return Context.make(FakeProcess, {
          commands: Ref.get(commands),
          kills: Ref.get(kills),
          printed: Ref.get(printed),
        }).pipe(
          Context.add(
            ChildProcessSpawner.ChildProcessSpawner,
            spawnerFor(behavior, commands, kills),
          ),
          Context.add(Stdio.Stdio, stdioFor(printed)),
        )
      }),
    )
}

/** @internal */
export default FakeProcess
