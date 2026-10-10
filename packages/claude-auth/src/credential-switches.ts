import {
  Cause,
  Effect,
  Match,
  Option,
  Predicate,
  Schedule,
  Schema,
  Stream,
} from "effect"
import ActiveCredential from "./active-credential.ts"
import DebugLog from "./debug-log.ts"
import type { Plugin } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import claudeCodeCredential from "./claude-code-credential.ts"

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

type ClaudeCodeCredential = ReturnType<typeof claudeCodeCredential.fromSource>

/** What following credential switches uses. */
type Switches = ActiveCredential | DebugLog

const AnthropicSwitch = Schema.Struct({
    data: Schema.Struct({
      integrationID: Schema.Literal(claudeCodeCredential.INTEGRATION_ID),
    }),
    type: Schema.Literal("credential.switched"),
  }),
  /** How long to wait before re-subscribing after the host's stream ends. */
  RESUBSCRIBE_DELAY = "1 second",
  /* The message of a failure, for a warning. */
  describe = (cause: unknown): string =>
    Option.liftPredicate(cause, Predicate.isError).pipe(
      Option.map((error: { readonly message: string }) => error.message),
      Option.getOrElse(() => String(cause)),
    ),
  /* The Claude Code credential behind the host's active Anthropic connection. */
  lookUpActive = Effect.fn("CredentialSwitches.lookUpActive")(
    function* lookUpActive(connection: Host["connection"]) {
      const active = Option.fromUndefinedOr(
        yield* connection.active(claudeCodeCredential.INTEGRATION_ID),
      )

      if (Option.isNone(active)) {
        return Option.none<ClaudeCodeCredential>()
      }

      return claudeCodeCredential.decodeHostValue(
        yield* connection.resolve(active.value),
      )
    },
  ),
  /*
   * Swap in the active connection's credential once it is known, so a
   * request racing the reload keeps the credential it would have used a
   * moment earlier instead of going out with none. A failed reload still
   * ends with none, because the user switched away from the old one.
   */
  makeActive = (
    connection: Host["connection"],
  ): Effect.Effect<void, unknown, ActiveCredential> =>
    ActiveCredential.pipe(
      Effect.flatMap((active) =>
        lookUpActive(connection).pipe(
          Effect.tapError(() => active.set(Option.none())),
          Effect.flatMap((next) => active.set(next)),
        ),
      ),
    ),
  /* Load the active credential, telling the user when it could not be. */
  noteActive = (
    connection: Host["connection"],
  ): Effect.Effect<void, never, Switches> =>
    DebugLog.pipe(
      Effect.flatMap((debugLog) =>
        makeActive(connection).pipe(
          Effect.tapError((cause) =>
            debugLog.warn("credential_reload_failed", {
              warning: `could not load the newly selected Anthropic credential, so Claude Code credentials are not applied until the next switch: ${describe(cause)}`,
            }),
          ),
          Effect.ignore,
        ),
      ),
    ),
  /* Reload the credential and the models after a switch. */
  onSwitch = (host: Host): Effect.Effect<void, never, Switches> =>
    DebugLog.pipe(
      Effect.flatMap((debugLog) =>
        noteActive(host.connection).pipe(
          Effect.andThen(host.reload()),
          Effect.catchDefect((cause) =>
            debugLog.log("model_reload_failed", { error: describe(cause) }),
          ),
        ),
      ),
    ),
  /*
   * Follow one subscription to the host's events until it ends. A failure
   * is logged rather than raised, so the caller can subscribe again.
   */
  watchSwitches = (host: Host): Effect.Effect<void, never, Switches> =>
    DebugLog.pipe(
      Effect.flatMap((debugLog) =>
        host.subscribe().pipe(
          Stream.filter(Schema.is(AnthropicSwitch)),
          Stream.runForEach(() => onSwitch(host)),
          Effect.catchCause((cause) =>
            Match.value(Cause.hasInterrupts(cause)).pipe(
              Match.when(true, () => Effect.interrupt),
              Match.orElse(() =>
                debugLog.log("credential_event_failed", {
                  error: Cause.pretty(cause),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  /* Follow the host's events for the plugin's lifetime, re-subscribing. */
  watchUntilClosed = (
    host: Host,
  ): Effect.Effect<unknown, never, Scope.Scope | Switches> =>
    watchSwitches(host).pipe(
      Effect.repeat(Schedule.spaced(RESUBSCRIBE_DELAY)),
      Effect.forkScoped,
    ),
  /*
   * Load the active credential, then follow the host's credential switches
   * for the plugin's lifetime. The host stream can fail or end while the
   * service keeps running, and a plugin that stops listening silently stops
   * following account switches, so it re-subscribes.
   */
  wireSwitches = (
    host: Host,
  ): Effect.Effect<void, never, Scope.Scope | Switches> =>
    noteActive(host.connection).pipe(
      Effect.andThen(watchUntilClosed(host)),
      Effect.asVoid,
    )

/** Keeping the active credential in step with the host's selection. */
export default Object.freeze({ start: wireSwitches })
