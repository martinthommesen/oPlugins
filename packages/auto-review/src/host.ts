import { Context, Effect, Layer, Option, Predicate } from "effect"
import type { Credential, Plugin } from "@opencode/plugin/effect"
import HostError from "./host-error.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { Session } from "@opencode/schema/session"
import type { SessionMessage } from "@opencode/schema/session-message"
import conversation from "./conversation.ts"

type SessionId = PermissionEvaluation["sessionID"]

interface SessionSnapshot {
  readonly items: ReturnType<typeof conversation.fromSessionMessages>
  readonly parentId: Option.Option<SessionId>
}

interface Interface {
  /** The active OpenAI connection's credential, when one is connected. */
  readonly openAiCredential: Effect.Effect<
    Option.Option<Credential.Value>,
    HostError
  >
  /** A session's conversation and its parent session, if it is a subagent. */
  readonly session: (
    sessionId: SessionId,
  ) => Effect.Effect<SessionSnapshot, HostError>
}

const OPENAI_INTEGRATION = "openai",
  /*
   * Reads a session through the plugin context. The host's calls fail with
   * `unknown`; each is mapped to a `HostError` naming the call.
   */
  sessionReader = (context: Plugin.Context): Interface["session"] =>
    Effect.fn("Host.session")(function* session(sessionId: SessionId) {
      const reads: Effect.Effect<
          readonly [Session.Info, readonly SessionMessage.Info[]],
          HostError
        > = Effect.all(
          [
            context.session
              .get({ sessionID: sessionId })
              .pipe(HostError.during("session.get")),
            context.session
              .context({ sessionID: sessionId })
              .pipe(HostError.during("session.context")),
          ],
          { concurrency: "unbounded" },
        ),
        [{ parentID }, transcript] = yield* reads

      return {
        items: conversation.fromSessionMessages(transcript),
        parentId: Option.fromUndefinedOr(parentID),
      }
    })

/** OpenCode server capabilities the reviewer reads, behind a service tag. */
class Host extends Context.Service<Host, Interface>()(
  "opencode-auto-review/host",
) {
  public static readonly fromPlugin = (
    context: Plugin.Context,
  ): Layer.Layer<Host> => {
    const { integration } = context,
      openAiCredential = Effect.gen(function* openAiCredential() {
        const connection =
          yield* integration.connection.active(OPENAI_INTEGRATION)

        if (Predicate.isNotUndefined(connection)) {
          const credential: Effect.Effect<
            Credential.Value | undefined,
            HostError
          > = integration.connection
            .resolve(connection)
            .pipe(HostError.during("integration.connection.resolve"))

          return Option.fromUndefinedOr(yield* credential)
        }

        return Option.none<Credential.Value>()
      })

    return Layer.succeed(
      Host,
      Host.of({ openAiCredential, session: sessionReader(context) }),
    )
  }
}

export default Host
