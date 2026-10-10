import { Context, Effect, HashSet, Layer, Option, Ref, Struct } from "effect"
import type { Model, Plugin } from "@opencode/plugin/effect"
import HostError from "./host-error.ts"
import type { Session } from "@opencode/schema/session"
import conversation from "./conversation.ts"

type ConversationItem = ReturnType<
  typeof conversation.fromSessionMessages
>[number]

type SessionApi = Pick<
  Plugin.Context["session"],
  "context" | "create" | "generate" | "get" | "remove" | "synthetic"
>

type ModelApi = Pick<Plugin.Context["model"], "list">

/*
 * The host's session operations the advisor uses, failing with `Failure`:
 * whatever the host fails with, which `Host` maps to `HostError`.
 */
type HostSession<Failure> = {
  readonly [Name in keyof SessionApi]: (
    ...input: Parameters<SessionApi[Name]>
  ) => Effect.Effect<Effect.Success<ReturnType<SessionApi[Name]>>, Failure>
}

/** The host APIs the advisor uses. */
interface HostContext<Failure> {
  readonly model: {
    readonly [Name in keyof ModelApi]: (
      ...input: Parameters<ModelApi[Name]>
    ) => Effect.Effect<Effect.Success<ReturnType<ModelApi[Name]>>, Failure>
  }
  readonly session: HostSession<Failure>
}

interface Interface {
  /**
   * Answers a prompt with the given model, in a short-lived child session of
   * the consulting session so the provider's session hooks apply.
   */
  readonly consult: (
    sessionId: Session.ID,
    prompt: string,
    model: Model.Ref,
  ) => Effect.Effect<string, HostError>
  /** Whether a session was created to answer a consultation. */
  readonly isConsultation: (sessionId: Session.ID) => Effect.Effect<boolean>
  /** The models the user can select. */
  readonly models: Effect.Effect<readonly Model.Info[], HostError>
  /** Shows a message in a session without starting a model turn. */
  readonly notify: (
    sessionId: Session.ID,
    text: string,
  ) => Effect.Effect<void, HostError>
  /** The session that started a subagent's session, if it is one. */
  readonly parent: (
    sessionId: Session.ID,
  ) => Effect.Effect<Option.Option<Session.ID>, HostError>
  /** A session's conversation, oldest first. */
  readonly transcript: (
    sessionId: Session.ID,
  ) => Effect.Effect<readonly ConversationItem[], HostError>
}

/** Records which sessions exist to answer a consultation. */
interface Tracker {
  readonly add: (sessionId: Session.ID) => Effect.Effect<void>
  readonly remove: (sessionId: Session.ID) => Effect.Effect<void>
}

const CLEANUP_RETRIES = 1,
  CLEANUP_TIMEOUT_SECONDS = 5,
  /* Maps any failure of a host call to a `HostError` naming the operation. */
  asHostError =
    (operation: string) =>
    <Value, Failure, Requirements>(
      self: Effect.Effect<Value, Failure, Requirements>,
    ): Effect.Effect<Value, HostError, Requirements> =>
      Effect.mapError(self, (cause) => HostError.make({ cause, operation })),
  /*
   * Deletes a consultation session with bounded cleanup and one retry,
   * keeping it tracked if deletion fails. The warning names the session
   * only: the host's error may quote the conversation.
   */
  cleanupSession =
    <Failure>(
      session: HostSession<Failure>,
      tracker: Tracker,
    ): Tracker["remove"] =>
    (id) =>
      session.remove({ sessionID: id }).pipe(
        Effect.retry({ times: CLEANUP_RETRIES }),
        Effect.interruptible,
        Effect.timeout(`${CLEANUP_TIMEOUT_SECONDS} seconds`),
        Effect.andThen(tracker.remove(id)),
        Effect.tapError(() =>
          Effect.logWarning("advisor_session_cleanup_failed").pipe(
            Effect.annotateLogs({ sessionID: id }),
          ),
        ),
        Effect.ignore,
      ),
  /*
   * Builds `consult` on the host's session API. `tracker` records the
   * sessions it creates; `close` starts their cleanup without delaying the
   * caller.
   */
  consultation =
    <Failure>(
      session: HostSession<Failure>,
      tracker: Tracker,
      close: Tracker["remove"],
    ): Interface["consult"] =>
    (sessionId, prompt, model) => {
      const ask = ({ id }: Session.Info): Effect.Effect<string, HostError> =>
          session
            .generate({ prompt, sessionID: id })
            .pipe(
              Effect.map(Struct.get("text")),
              asHostError("session.generate"),
            ),
        open = session
          .create({ model, parentID: sessionId, title: "Advisor" })
          .pipe(asHostError("session.create"))

      // Keep tracking and release registration atomic after creation succeeds.
      return Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          restore(open).pipe(Effect.tap(({ id }) => tracker.add(id))),
          (child) => restore(ask(child)),
          ({ id }) => close(id),
        ),
      )
    },
  /* Adapts the host's session API to the read and notify operations of `Host`. */
  sessionOperations = <Failure>(
    session: HostSession<Failure>,
  ): Pick<Interface, "notify" | "parent" | "transcript"> => ({
    notify: (sessionId, text) =>
      session
        .synthetic({
          description: "advisor",
          resume: false,
          sessionID: sessionId,
          text,
        })
        .pipe(Effect.asVoid, asHostError("session.synthetic")),
    parent: (sessionId) =>
      session.get({ sessionID: sessionId }).pipe(
        Effect.map(({ parentID }) => Option.fromUndefinedOr(parentID)),
        asHostError("session.get"),
      ),
    transcript: (sessionId) =>
      session.context({ sessionID: sessionId }).pipe(
        Effect.map((messages) => conversation.fromSessionMessages(messages)),
        asHostError("session.context"),
      ),
  })

/** OpenCode server capabilities the advisor uses, behind a service tag. */
class Host extends Context.Service<Host, Interface>()(
  "@martinthommesen/oc-advisor/host",
) {
  /* Adapts the plugin context's host APIs to the `Host` service. */
  public static readonly fromPlugin = <Failure>(
    context: HostContext<Failure>,
  ): Layer.Layer<Host> =>
    Layer.effect(
      Host,
      Effect.gen(function* makeHost() {
        const models = context.model
            .list()
            .pipe(Effect.map(Struct.get("data")), asHostError("model.list")),
          operations = sessionOperations(context.session),
          scope = yield* Effect.scope,
          tracked = yield* Ref.make(HashSet.empty<Session.ID>()),
          tracker: Tracker = {
            add: (id) => Ref.update(tracked, HashSet.add(id)),
            remove: (id) => Ref.update(tracked, HashSet.remove(id)),
          },
          wipe = cleanupSession(context.session, tracker)

        return Host.of({
          consult: consultation(context.session, tracker, (id) =>
            wipe(id).pipe(
              Effect.forkIn(scope, { uninterruptible: true }),
              Effect.asVoid,
            ),
          ),
          isConsultation: (sessionId) =>
            Ref.get(tracked).pipe(Effect.map(HashSet.has(sessionId))),
          models,
          notify: operations.notify,
          parent: operations.parent,
          transcript: operations.transcript,
        })
      }),
    )
}

export default Host
