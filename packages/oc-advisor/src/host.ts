import { Context, Effect, Layer, Option, Struct } from "effect"
import type { Model, Plugin } from "@opencode/plugin/effect"
import HostError from "./host-error.ts"
import type { Session } from "@opencode/schema/session"
import consultationAgent from "./consultation-agent.ts"
import conversation from "./conversation.ts"

type SessionApi = Pick<
  Plugin.Context["session"],
  "context" | "create" | "generate" | "get" | "remove" | "synthetic"
>

type ModelApi = Pick<Plugin.Context["model"], "list">

/*
 * The host's session operations the advisor uses, failing with `Failure`.
 * The host's own operations fail with `unknown`, which the Effect
 * diagnostics reject in any error channel, so this code is generic in the
 * failure until `asHostError` maps it to `HostError`.
 */
type HostSession<Failure> = {
  readonly [Name in keyof SessionApi]: (
    ...input: Parameters<SessionApi[Name]>
  ) => Effect.Effect<Effect.Success<ReturnType<SessionApi[Name]>>, Failure>
}

/** The parts of the host's plugin context the advisor uses. */
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
   * Answers a prompt with the given model, in a short-lived consultation
   * session under the consulting session, run as the consultation agent, so
   * the provider's session hooks apply.
   */
  readonly consult: (
    sessionId: Session.ID,
    prompt: string,
    model: Model.Ref,
  ) => Effect.Effect<string, HostError>
  /** The host's models, each marked enabled or not. */
  readonly models: Effect.Effect<readonly Model.Info[], HostError>
  /** Shows a message in a session without starting a model turn. */
  readonly notify: (
    sessionId: Session.ID,
    text: string,
  ) => Effect.Effect<void, HostError>
  /** A session's parent session, if it has one, as a subagent's session does. */
  readonly parent: (
    sessionId: Session.ID,
  ) => Effect.Effect<Option.Option<Session.ID>, HostError>
  /** A session's conversation, oldest first. */
  readonly transcript: (
    sessionId: Session.ID,
  ) => Effect.Effect<
    ReturnType<typeof conversation.fromSessionMessages>,
    HostError
  >
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
   * Deletes a consultation session with one retry and a deadline. The
   * warning names the session only, because the host's error may quote the
   * conversation.
   */
  cleanupSession =
    <Failure>(session: HostSession<Failure>) =>
    (id: Session.ID): Effect.Effect<void> =>
      session.remove({ sessionID: id }).pipe(
        Effect.retry({ times: CLEANUP_RETRIES }),
        Effect.timeout(`${CLEANUP_TIMEOUT_SECONDS} seconds`),
        Effect.tapError(() =>
          Effect.logWarning("advisor_session_cleanup_failed").pipe(
            Effect.annotateLogs({ sessionID: id }),
          ),
        ),
        Effect.ignore,
      ),
  /*
   * Builds `consult` on the host's session API. `close` starts the cleanup
   * of the sessions it creates without delaying the caller.
   */
  consultation =
    <Failure>(
      session: HostSession<Failure>,
      close: (id: Session.ID) => Effect.Effect<void>,
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
          .create({
            agent: consultationAgent.ID,
            model,
            parentID: sessionId,
            permissions: consultationAgent.denyAll(),
            title: "Advisor",
          })
          .pipe(asHostError("session.create"))

      /*
       * `acquireUseRelease` alone would make a stalled creation
       * uninterruptible. Restoring `open` lets the deadline interrupt it,
       * while registering a created session's release stays uninterruptible.
       */
      return Effect.uninterruptibleMask((restore) =>
        Effect.acquireUseRelease(
          restore(open),
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

/** The host operations the advisor uses, behind a service tag. */
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
          wipe = cleanupSession(context.session)

        return Host.of({
          // Uninterruptible, so closing the plugin waits for pending deletions.
          consult: consultation(context.session, (id) =>
            wipe(id).pipe(
              Effect.forkIn(scope, { uninterruptible: true }),
              Effect.asVoid,
            ),
          ),
          models,
          notify: operations.notify,
          parent: operations.parent,
          transcript: operations.transcript,
        })
      }),
    )
}

export default Host
