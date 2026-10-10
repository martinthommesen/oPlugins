import { Context, Effect, HashSet, Layer, Option, Ref, Struct } from "effect"
import type { Model, Plugin } from "@opencode/plugin/effect"
import type { ConversationItem } from "./conversation.ts"
import type { HostError } from "./errors/host-error.ts"
import type { Session } from "@opencode/schema/session"
import { fromSessionMessages } from "./conversation.ts"
import { hostError } from "./errors/host-error.ts"

type SessionId = Session.ID

type SessionDomain = Plugin.Context["session"]

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
 * @returns {Interface["consult"]} The operation.
 */
const consultation =
  (session: SessionDomain, tracker: Tracker): Interface["consult"] =>
  (sessionId, prompt, model) => {
    const open = session
      .create({ model, parentID: sessionId, title: "Advisor" })
      .pipe(
        hostError("session.create"),
        Effect.tap(({ id }) => tracker.add(id)),
      )

    const close = ({ id }: Session.Info): Effect.Effect<void> =>
      tracker
        .remove(id)
        .pipe(Effect.andThen(session.remove({ sessionID: id })), Effect.ignore)

    const ask = ({ id }: Session.Info): Effect.Effect<string, HostError> =>
      session
        .generate({ prompt, sessionID: id })
        .pipe(Effect.map(Struct.get("text")), hostError("session.generate"))

    return Effect.acquireUseRelease(open, ask, close)
  }

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
   * @param {Plugin.Context} context The plugin context OpenCode passed in.
   * @returns {Layer.Layer<Host>} A layer providing `Host`.
   */
  public static readonly fromPlugin = (
    context: Plugin.Context,
  ): Layer.Layer<Host> =>
    Layer.effect(
      Host,
      Effect.gen(function* makeHost() {
        const { model, session } = context

        const consultations = yield* Ref.make(HashSet.empty<SessionId>())

        const tracker: Tracker = {
          add: (id) => Ref.update(consultations, HashSet.add(id)),
          remove: (id) => Ref.update(consultations, HashSet.remove(id)),
        }

        const { notify, parent, transcript } = sessionOperations(session)

        const models = model
          .list()
          .pipe(Effect.map(Struct.get("data")), hostError("model.list"))

        return Host.of({
          consult: consultation(session, tracker),
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

export type { Interface as HostInterface, SessionId }
