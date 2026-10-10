import { Context, Effect, HashSet, Layer, Option, Ref, Struct } from "effect"
import type { Model, Plugin } from "@opencode/plugin/effect"
import type { ConversationItem } from "./conversation.ts"
import type { HostError } from "./errors/host-error.ts"
import type { Session } from "@opencode/schema/session"
import { fromSessionMessages } from "./conversation.ts"
import { hostError } from "./errors/host-error.ts"

type SessionId = Session.ID

const CLEANUP_TIMEOUT_SECONDS = 5

const CLEANUP_RETRIES = 1

type SessionDomain = Pick<
  Plugin.Context["session"],
  "create" | "generate" | "remove" | "synthetic" | "get" | "context"
>

interface HostContext {
  readonly model: Pick<Plugin.Context["model"], "list">
  readonly session: SessionDomain
}

interface Interface {
  /**
   * Answers a prompt with the given model, in a short-lived child session of
   * the consulting session so the provider's session hooks apply.
   */
  readonly consult: (
    sessionId: SessionId,
    prompt: string,
    model: Model.Ref,
  ) => Effect.Effect<string, HostError>
  /** Whether a session was created to answer a consultation. */
  readonly isConsultation: (sessionId: SessionId) => Effect.Effect<boolean>
  /** The models the user can select. */
  readonly models: Effect.Effect<readonly Model.Info[], HostError>
  /** Shows a message in a session without starting a model turn. */
  readonly notify: (
    sessionId: SessionId,
    text: string,
  ) => Effect.Effect<void, HostError>
  /** The session that started a subagent's session, if it is one. */
  readonly parent: (
    sessionId: SessionId,
  ) => Effect.Effect<Option.Option<SessionId>, HostError>
  /** A session's conversation, oldest first. */
  readonly transcript: (
    sessionId: SessionId,
  ) => Effect.Effect<readonly ConversationItem[], HostError>
}

/** Records which sessions exist to answer a consultation. */
interface Tracker {
  readonly add: (sessionId: SessionId) => Effect.Effect<void>
  readonly remove: (sessionId: SessionId) => Effect.Effect<void>
}

/**
 * Builds `consult` on the host's session API.
 * @param {SessionDomain} session The host's session API.
 * @param {Tracker} tracker Records the sessions `consult` creates.
 * @param {Tracker["remove"]} close Starts cleanup without delaying the caller.
 * @returns {Interface["consult"]} The operation.
 */
const consultation =
  (
    session: SessionDomain,
    tracker: Tracker,
    close: Tracker["remove"],
  ): Interface["consult"] =>
  (sessionId, prompt, model) => {
    const open = session
      .create({ model, parentID: sessionId, title: "Advisor" })
      .pipe(hostError("session.create"))

    const ask = ({ id }: Session.Info): Effect.Effect<string, HostError> =>
      session
        .generate({ prompt, sessionID: id })
        .pipe(Effect.map(Struct.get("text")), hostError("session.generate"))

    // Keep tracking and release registration atomic after creation succeeds.
    return Effect.uninterruptibleMask((restore) =>
      Effect.acquireUseRelease(
        restore(open).pipe(Effect.tap(({ id }) => tracker.add(id))),
        (child) => restore(ask(child)),
        ({ id }) => close(id),
      ),
    )
  }

/**
 * Deletes a consultation session, keeping it tracked if deletion fails.
 * @param {SessionDomain} session The host's session API.
 * @param {Tracker} tracker Records consultation sessions until deletion succeeds.
 * @returns {Tracker["remove"]} Bounded cleanup with one retry.
 */
const cleanupSession =
  (session: SessionDomain, tracker: Tracker): Tracker["remove"] =>
  (id) =>
    session.remove({ sessionID: id }).pipe(
      Effect.retry({ times: CLEANUP_RETRIES }),
      Effect.interruptible,
      Effect.timeout(`${CLEANUP_TIMEOUT_SECONDS} seconds`),
      Effect.andThen(tracker.remove(id)),
      Effect.ignore({
        log: "Warn",
        message: `Could not remove advisor session ${id}`,
      }),
    )

/**
 * Adapts the host's session API to the read and notify operations of `Host`.
 * @param {SessionDomain} session The host's session API.
 * @returns {Pick<Interface, "notify" | "parent" | "transcript">} The operations.
 */
const sessionOperations = (
  session: SessionDomain,
): Pick<Interface, "notify" | "parent" | "transcript"> => ({
  notify: (sessionId, text) =>
    session
      .synthetic({
        description: "advisor",
        resume: false,
        sessionID: sessionId,
        text,
      })
      .pipe(Effect.asVoid, hostError("session.synthetic")),
  parent: (sessionId) =>
    session.get({ sessionID: sessionId }).pipe(
      Effect.map(({ parentID }) => Option.fromUndefinedOr(parentID)),
      hostError("session.get"),
    ),
  transcript: (sessionId) =>
    session
      .context({ sessionID: sessionId })
      .pipe(Effect.map(fromSessionMessages), hostError("session.context")),
})

/** OpenCode server capabilities the advisor uses, behind a service tag. */
class Host extends Context.Service<Host, Interface>()("opencode-advisor/Host") {
  /**
   * Adapts the plugin context to the `Host` service.
   * @param {HostContext} context The host APIs the advisor uses.
   * @returns {Layer.Layer<Host>} A layer providing `Host`.
   */
  public static readonly fromPlugin = (
    context: HostContext,
  ): Layer.Layer<Host> =>
    Layer.effect(
      Host,
      Effect.gen(function* makeHost() {
        const { model, session } = context

        const scope = yield* Effect.scope

        const consultations = yield* Ref.make(HashSet.empty<SessionId>())

        const tracker: Tracker = {
          add: (id) => Ref.update(consultations, HashSet.add(id)),
          remove: (id) => Ref.update(consultations, HashSet.remove(id)),
        }

        const { notify, parent, transcript } = sessionOperations(session)

        const cleanup = cleanupSession(session, tracker)

        const models = model
          .list()
          .pipe(Effect.map(Struct.get("data")), hostError("model.list"))

        return Host.of({
          consult: consultation(session, tracker, (id) =>
            cleanup(id).pipe(
              Effect.forkIn(scope, { uninterruptible: true }),
              Effect.asVoid,
            ),
          ),
          isConsultation: (sessionId) =>
            Ref.get(consultations).pipe(Effect.map(HashSet.has(sessionId))),
          models,
          notify,
          parent,
          transcript,
        })
      }),
    )
}

export { Host }

export type { HostContext, Interface as HostInterface, SessionId }
