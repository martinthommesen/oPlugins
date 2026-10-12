import {
  Cause,
  Effect,
  Exit,
  Fiber,
  Latch,
  Match,
  Option,
  Predicate,
  Ref,
  Schema,
  Semaphore,
  Stream,
} from "effect"
import ActiveCredential from "./active-credential.ts"
import type { Plugin } from "@opencode/plugin/effect"
import claudeCodeCredential from "./claude-code-credential.ts"
import pluginLog from "./plugin-log.ts"

type Connection = Plugin.Context["integration"]["connection"]

/** The host pieces that following credential switches needs. */
interface Host {
  readonly connection: Pick<Connection, "active" | "resolve">
  readonly reload: Plugin.Context["model"]["reload"]
  /*
   * The host's events. Only their `type` is relied on; a switch is decoded,
   * because events are untrusted input.
   */
  readonly subscribe: () => Stream.Stream<{ readonly type: string }, unknown>
}

/** What following the host's selection keeps for the plugin's lifetime. */
interface Following {
  /** Lets one lookup at a time apply what it came to. */
  readonly applying: Semaphore.Semaphore
  readonly host: Host
  /** The ticket of the newest lookup of the host's selection. */
  readonly latest: Ref.Ref<number>
}

type ClaudeCodeCredential = ReturnType<typeof claudeCodeCredential.fromSource>

type Selection = Option.Option<ClaudeCodeCredential>

type Resolved = Effect.Success<ReturnType<Connection["resolve"]>>

/** What following credential switches uses. */
type Switches = ActiveCredential

const AnthropicSwitch = Schema.Struct({
    data: Schema.Struct({
      integrationID: Schema.Literal(claudeCodeCredential.INTEGRATION_ID),
    }),
    type: Schema.Literal("credential.switched"),
  }),
  NEXT = 1,
  NO_LOOKUPS = 0,
  ONE_AT_A_TIME = 1,
  /** How long to wait before re-subscribing after the host's stream ends. */
  RESUBSCRIBE_DELAY = "1 second",
  /* The message of a failure, for a debug record. */
  describe = (cause: unknown): string =>
    Option.liftPredicate(cause, Predicate.isError).pipe(
      Option.map((error: { readonly message: string }) => error.message),
      Option.getOrElse(() => String(cause)),
    ),
  /*
   * Warn that the selected credential could not be loaded, with no content;
   * the `message` of its cause goes in a debug record.
   */
  failedReload = (message: string): Effect.Effect<void> =>
    pluginLog
      .warning("credential_reload_failed", {})
      .pipe(
        Effect.andThen(
          pluginLog.debug("credential_reload_failed", { error: message }),
        ),
      ),
  /* Why a lookup failed: the host's untyped failure, or the defect. */
  failureOf = (cause: Cause.Cause<Cause.UnknownError>): string =>
    Option.match(Cause.findErrorOption(cause), {
      onNone: () => describe(Cause.squash(cause)),
      onSome: (failure: { readonly cause?: unknown }) =>
        describe(failure.cause),
    }),
  /*
   * The credential to use after a lookup of the host's selection came to
   * `looked`. A lookup that failed leaves none, after a warning, because the
   * one in use may not be the one the user selected.
   */
  inUse = (
    looked: Exit.Exit<Selection, Cause.UnknownError>,
  ): Effect.Effect<Selection> =>
    Exit.match(looked, {
      onFailure: (cause) =>
        cause.pipe(failureOf, failedReload, Effect.as(Option.none())),
      onSuccess: (selected) => Effect.succeed(selected),
    }),
  /*
   * Whether `current` already serves `selected`: both none, or credentials
   * of the same Claude Code account where `current` lasts at least as long.
   * The one in use may hold tokens adopted since the host stored its copy.
   */
  isServing = (current: Selection, selected: Selection): boolean =>
    Option.match(current, {
      onNone: () => Option.isNone(selected),
      onSome: (used) =>
        Option.exists(
          selected,
          (wanted) =>
            wanted.metadata.source === used.metadata.source &&
            wanted.metadata.configDir === used.metadata.configDir &&
            wanted.expires <= used.expires,
        ),
    }),
  /*
   * The Claude Code credential behind the host's active Anthropic connection.
   * The host leaves a failed resolve untyped; it is kept as the cause.
   */
  lookUpActive = Effect.fn("CredentialSwitches.lookUpActive")(
    function* lookUpActive(connection: Host["connection"]) {
      const active = Option.fromUndefinedOr(
        yield* connection.active(claudeCodeCredential.INTEGRATION_ID),
      )

      if (Option.isSome(active)) {
        const resolving: Effect.Effect<Resolved, Cause.UnknownError> =
          connection
            .resolve(active.value)
            .pipe(Effect.mapError((cause) => new Cause.UnknownError(cause)))

        return claudeCodeCredential.decodeHostValue(yield* resolving)
      }

      return Option.none<ClaudeCodeCredential>()
    },
  ),
  /*
   * Look up the host's selection and `apply` the credential it comes to,
   * unless a newer lookup started meanwhile, so a slow lookup never
   * overwrites a newer selection. The host reports problems with its
   * active connection as defects, which fail the lookup like any failure.
   * Whether `apply` changed the credential in use.
   */
  lookUpLatest = Effect.fn("CredentialSwitches.lookUpLatest")(
    function* lookUpLatest(
      following: Following,
      apply: (selected: Selection) => Effect.Effect<boolean, never, Switches>,
    ) {
      const claimed = yield* Ref.updateAndGet(
          following.latest,
          (latest) => latest + NEXT,
        ),
        looked = yield* Effect.exit(lookUpActive(following.host.connection))

      return yield* following.applying.withPermits(ONE_AT_A_TIME)(
        Ref.get(following.latest).pipe(
          Effect.flatMap((latest) => {
            if (latest !== claimed) {
              return Effect.succeed(false)
            }

            return inUse(looked).pipe(Effect.flatMap(apply))
          }),
        ),
      )
    },
  ),
  /* Use `selected` from now on; a switch always replaces the credential. */
  madeActive = (selected: Selection): Effect.Effect<boolean, never, Switches> =>
    ActiveCredential.pipe(
      Effect.flatMap((active) => active.set(selected)),
      Effect.as(true),
    ),
  /*
   * Use `selected` from now on, unless the credential in use already serves
   * it. Whether the credential in use changed.
   */
  madeActiveUnlessServed = Effect.fn("CredentialSwitches.reconcile")(
    function* madeActiveUnlessServed(selected: Selection) {
      const active = yield* ActiveCredential

      if (isServing(yield* active.current, selected)) {
        return false
      }

      return yield* madeActive(selected)
    },
  ),
  /* Reload the models, whose pricing follows the credential in use. */
  modelsReloaded = (host: Host): Effect.Effect<void> =>
    host
      .reload()
      .pipe(
        Effect.catchDefect((cause) =>
          pluginLog.debug("model_reload_failed", { error: describe(cause) }),
        ),
      ),
  /*
   * Swap in the selected credential once it is known, so a request racing
   * the lookup keeps the credential it would have used a moment earlier
   * instead of going out with none, then reload the models.
   */
  onSwitch = (following: Following): Effect.Effect<void, never, Switches> =>
    lookUpLatest(following, madeActive).pipe(
      Effect.andThen(modelsReloaded(following.host)),
    ),
  /*
   * Follow one subscription to the host's events until it ends. A failure
   * is logged rather than raised, so the caller can subscribe again.
   */
  watchSwitches = (
    following: Following,
  ): Effect.Effect<void, never, Switches> =>
    following.host.subscribe().pipe(
      Stream.filter(Schema.is(AnthropicSwitch)),
      Stream.runForEach(() => onSwitch(following)),
      Effect.catchCause((cause) =>
        Match.value(Cause.hasInterrupts(cause)).pipe(
          Match.when(true, () => Effect.interrupt),
          Match.orElse(() =>
            pluginLog.debug("credential_event_failed", {
              error: Cause.pretty(cause),
            }),
          ),
        ),
      ),
    ),
  /*
   * Subscribe to the host's events, then bring the credential in use in
   * step with the host's selection, and hand `afterward` whether that
   * changed it. The subscription starts at once, before the lookup, so a
   * switch is either one the lookup sees or one the subscription delivers.
   * Ends when the subscription does.
   */
  whileSubscribed = Effect.fn("CredentialSwitches.whileSubscribed")(
    function* whileSubscribed(
      following: Following,
      afterward: (changed: boolean) => Effect.Effect<unknown, never, Switches>,
    ) {
      const listening = yield* Effect.forkChild(watchSwitches(following), {
          startImmediately: true,
        }),
        selectionChanged = yield* lookUpLatest(
          following,
          madeActiveUnlessServed,
        )

      yield* afterward(selectionChanged)
      yield* Fiber.join(listening)
    },
  ),
  /*
   * Load the active credential, then follow the host's credential switches
   * for the plugin's lifetime. The host stream can fail or end while the
   * service keeps running, and a plugin that stops listening silently stops
   * following account switches, so it re-subscribes, and catches up with a
   * switch it missed meanwhile, reloading the models when it did.
   */
  wireSwitches = Effect.fn("CredentialSwitches.start")(function* wireSwitches(
    host: Host,
  ) {
    const following: Following = {
        applying: yield* Semaphore.make(ONE_AT_A_TIME),
        host,
        latest: yield* Ref.make(NO_LOOKUPS),
      },
      reconnected = (changed: boolean): Effect.Effect<unknown> =>
        modelsReloaded(host).pipe(Effect.when(Effect.succeed(changed))),
      resubscribing = whileSubscribed(following, reconnected).pipe(
        Effect.delay(RESUBSCRIBE_DELAY),
        Effect.forever,
      ),
      started = yield* Latch.make(false)

    yield* whileSubscribed(following, () => started.open).pipe(
      Effect.andThen(resubscribing),
      Effect.forkScoped,
    )
    yield* started.await
  })

/** Keeping the active credential in step with the host's selection. */
export default Object.freeze({ start: wireSwitches })
