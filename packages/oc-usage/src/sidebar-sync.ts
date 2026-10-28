import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Function as Fn,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schedule,
  Scope,
  Semaphore,
} from "effect"
import type { Exit } from "effect"
import UsageUnavailable from "./usage-unavailable-error.ts"
import cliExit from "./cli-exit.ts"
import usageClient from "./usage-client.ts"
import type usageCommands from "./usage-commands.ts"

type Connection = Parameters<typeof usageClient.sidebar>[typeof FIRST]

type RunResult = ReturnType<
  ReturnType<typeof usageCommands.usageCommands>[number]["run"]
>

interface Controls {
  readonly apply: (shown: boolean) => void
  readonly connection: Connection
  readonly warn: (message: string) => void
}

interface State {
  readonly busy: Ref.Ref<boolean>
  readonly changed: Ref.Ref<Deferred.Deferred<boolean>>
  readonly closed: Ref.Ref<boolean>
  readonly generation: Ref.Ref<number>
}

interface Watch {
  readonly close: () => void
  readonly follow: Effect.Effect<void>
  readonly launch: (program: Effect.Effect<unknown>) => () => void
  readonly refresh: Effect.Effect<void, UsageUnavailable>
  readonly run: (program: Effect.Effect<unknown>) => RunResult
}

const FIRST = 0,
  NEXT = 1,
  NO_SHOWN = Option.none<boolean>(),
  PERMIT = 1,
  RETRIES = 60,
  background = (
    refresh: Effect.Effect<void, UsageUnavailable>,
    controls: Controls,
  ): Effect.Effect<void> =>
    refresh.pipe(
      Effect.catchTag(
        "UsageUnavailable",
        (failure: { readonly message: string }) =>
          Effect.logWarning("usage_sidebar_restore_failed").pipe(
            Effect.andThen(
              Effect.sync(() => {
                controls.apply(false)
                controls.warn(
                  `Couldn't restore usage visibility. ${failure.message} Retry /show-usage on.`,
                )
              }),
            ),
          ),
      ),
    ),
  guarded = (
    controls: Controls,
    program: Effect.Effect<unknown>,
  ): Effect.Effect<unknown> =>
    program.pipe(
      Effect.catchDefect(() =>
        Effect.logError("usage_cli_task_failed").pipe(
          Effect.andThen(
            Effect.sync(() => {
              controls.warn(
                "Usage stopped updating after a CLI error. Hide and show usage again; if it persists, restart OpenCode.",
              )
            }),
          ),
        ),
      ),
    ),
  invalidate = Effect.fnUntraced(function* invalidate(state: State) {
    const next = yield* Deferred.make<boolean>(),
      previous = yield* Ref.getAndSet(state.changed, next).pipe(
        Effect.tap(() => Ref.update(state.generation, (value) => value + NEXT)),
      )

    yield* Deferred.succeed(previous, true)
  }),
  readSetting = (
    controls: Controls,
  ): Effect.Effect<boolean, UsageUnavailable> =>
    usageClient.sidebar(controls.connection).pipe(
      Effect.timeoutOrElse({
        duration: "15 seconds",
        orElse: () =>
          Effect.fail(
            UsageUnavailable.make({
              message:
                "Reading sidebar visibility timed out. Check the OpenCode server and retry.",
            }),
          ),
      }),
      Effect.retry({
        schedule: Schedule.spaced("2 seconds"),
        times: RETRIES,
      }),
    ),
  /* An event invalidates an in-flight read. Only an answer for the newest
   * generation is applied; every waiter follows through to that answer.
   */
  reconcile = Effect.fnUntraced(function* reconcile(
    controls: Controls,
    state: State,
  ) {
    const answer = readSetting(controls).pipe(Effect.asSome),
      before = yield* Ref.get(state.generation),
      changed = yield* Ref.get(state.changed),
      current = yield* Effect.raceFirst(
        answer,
        Deferred.await(changed).pipe(Effect.as(NO_SHOWN)),
      ),
      latest = yield* Ref.get(state.generation),
      stopped = yield* Ref.get(state.closed)

    if (stopped) {
      return yield* Effect.interrupt
    }

    if (before !== latest || Option.isNone(current)) {
      return true
    }

    controls.apply(current.value)

    return false
  }),
  refreshIn = Effect.fnUntraced(function* refreshIn(
    controls: Controls,
    state: State,
  ) {
    yield* Ref.set(state.busy, true)
    yield* reconcile(controls, state).pipe(
      Effect.repeat({ while: (again) => again }),
      Effect.ensuring(Ref.set(state.busy, false)),
    )
  }),
  shutdown =
    (closing: Ref.Ref<boolean>, dispose: Effect.Effect<void>): (() => void) =>
    () => {
      if (Ref.getUnsafe(closing)) {
        return
      }

      Effect.runFork(Ref.set(closing, true))
      Effect.runFork(dispose)
    }

class SidebarWatcher extends Context.Service<
  SidebarWatcher,
  {
    readonly follow: Effect.Effect<void>
    readonly refresh: Effect.Effect<void, UsageUnavailable>
  }
>()("@martinthommesen/oc-usage/sidebar-sync/SidebarWatcher") {
  public static readonly layer = (
    controls: Controls,
    stopped: Ref.Ref<boolean> = Ref.makeUnsafe(false),
  ): Layer.Layer<SidebarWatcher> =>
    Layer.effect(
      SidebarWatcher,
      Effect.gen(function* build() {
        const changed = yield* Deferred.make<boolean>(),
          lock = yield* Semaphore.make(PERMIT),
          scope = yield* Scope.Scope,
          state = yield* Effect.all({
            busy: Ref.make(false),
            changed: Ref.make(changed),
            closed: Effect.succeed(stopped),
            generation: Ref.make(FIRST),
          }),
          task = lock.withPermits(PERMIT)(refreshIn(controls, state)),
          tracked = task.pipe(
            Effect.forkIn(scope),
            Effect.flatMap((fiber) =>
              Fiber.join(fiber).pipe(Effect.ensuring(Fiber.interrupt(fiber))),
            ),
          ),
          update = invalidate(state).pipe(Effect.andThen(tracked)),
          updating = background(update, controls),
          wait = Effect.sleep("1 minute").pipe(
            Effect.andThen(Ref.get(state.busy)),
            Effect.flatMap((busy) => {
              if (busy) {
                return Effect.void
              }

              return updating
            }),
          )

        yield* Effect.addFinalizer(() => Ref.set(state.closed, true))
        yield* Effect.forkIn(Effect.forever(wait), scope)

        return SidebarWatcher.of({ follow: updating, refresh: update })
      }),
    )

  public static readonly start = (controls: Controls): Watch => {
    const closing = Ref.makeUnsafe(false),
      runtime = ManagedRuntime.make(SidebarWatcher.layer(controls, closing)),
      started = runtime.contextEffect.pipe(
        Effect.flatMap(
          (context) => Context.get(context, SidebarWatcher).follow,
        ),
      ),
      update = runtime.contextEffect.pipe(
        Effect.flatMap(
          (context) => Context.get(context, SidebarWatcher).refresh,
        ),
      )

    runtime.runFork(started)

    return {
      close: shutdown(closing, runtime.disposeEffect),
      follow: started,
      launch: (program) => {
        if (Ref.getUnsafe(closing)) {
          return Fn.constVoid
        }

        const running = runtime.runFork(guarded(controls, program))

        return () => {
          Effect.runFork(Fiber.interrupt(running))
        }
      },
      refresh: update,
      run: (program): RunResult => {
        if (Ref.getUnsafe(closing)) {
          return
        }

        return Effect.runPromise(
          Effect.promise((signal): PromiseLike<Exit.Exit<unknown>> =>
            runtime.runPromiseExit(program, { signal }),
          ).pipe(Effect.flatMap(cliExit.finish)),
        )
      },
    }
  }
}

export default SidebarWatcher
