import {
  Context,
  Deferred,
  Effect,
  Fiber,
  Layer,
  ManagedRuntime,
  Option,
  Ref,
  Schedule,
  Scope,
  Semaphore,
} from "effect"
import UsageUnavailable from "./usage-unavailable-error.ts"
import usageClient from "./usage-client.ts"

type Connection = Parameters<typeof usageClient.sidebar>[typeof FIRST]

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
  readonly refresh: Effect.Effect<void>
}

const FIRST = 0,
  NEXT = 1,
  NO_SHOWN = Option.none<boolean>(),
  PERMIT = 1,
  RETRIES = 60,
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
      Effect.catchTag(
        "UsageUnavailable",
        (failure: { readonly message: string }) =>
          Effect.sync(() => {
            controls.warn(
              `Couldn't restore usage visibility. ${failure.message} Retry /show-usage on.`,
            )
          }),
      ),
      Effect.ensuring(Ref.set(state.busy, false)),
    )
  })

class SidebarWatcher extends Context.Service<
  SidebarWatcher,
  { readonly refresh: Effect.Effect<void> }
>()("@martinthommesen/oc-usage/sidebar-sync/SidebarWatcher") {
  public static readonly layer = (
    controls: Controls,
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
            closed: Ref.make(false),
            generation: Ref.make(FIRST),
          }),
          task = lock.withPermits(PERMIT)(refreshIn(controls, state)),
          tracked = task.pipe(
            Effect.forkIn(scope),
            Effect.flatMap((fiber) => Fiber.join(fiber)),
          ),
          update = invalidate(state).pipe(Effect.andThen(tracked)),
          wait = Effect.sleep("1 minute").pipe(
            Effect.andThen(Ref.get(state.busy)),
            Effect.flatMap((busy) => {
              if (busy) {
                return Effect.void
              }

              return update
            }),
          )

        yield* Effect.addFinalizer(() => Ref.set(state.closed, true))
        yield* Effect.forkIn(Effect.forever(wait), scope)

        return SidebarWatcher.of({ refresh: update })
      }),
    )

  public static readonly start = (controls: Controls): Watch => {
    const runtime = ManagedRuntime.make(SidebarWatcher.layer(controls)),
      update = runtime.contextEffect.pipe(
        Effect.flatMap(
          (context) => Context.get(context, SidebarWatcher).refresh,
        ),
      )

    runtime.runFork(update)

    return {
      close: () => {
        Effect.runFork(runtime.disposeEffect)
      },
      refresh: update,
    }
  }
}

export default SidebarWatcher
