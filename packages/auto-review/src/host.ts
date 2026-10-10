import { Context, Effect, Layer, Option, Predicate } from "effect"
import type { Credential, Plugin } from "@opencode/plugin/effect"
import type { ConversationItem } from "./conversation.ts"
import type { HostError } from "./errors/host-error.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { fromSessionMessages } from "./conversation.ts"
import { hostError } from "./errors/host-error.ts"

type SessionId = PermissionEvaluation["sessionID"]

interface SessionSnapshot {
  readonly items: readonly ConversationItem[]
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

const OPENAI_INTEGRATION = "openai"

/** OpenCode server capabilities the reviewer reads, behind a service tag. */
class Host extends Context.Service<Host, Interface>()(
  "opencode-auto-review/Host",
) {
  public static readonly fromPlugin = (
    context: Plugin.Context,
  ): Layer.Layer<Host> => {
    const { integration } = context
    const sessions = context.session

    const openAiCredential = Effect.gen(function* openAiCredential() {
      const connection =
        yield* integration.connection.active(OPENAI_INTEGRATION)

      if (Predicate.isUndefined(connection)) {
        return Option.none<Credential.Value>()
      }

      const credential = yield* integration.connection
        .resolve(connection)
        .pipe(hostError("integration.connection.resolve"))

      return Option.fromUndefinedOr(credential)
    })

    const session = Effect.fn("Host.session")(function* session(
      sessionId: SessionId,
    ) {
      const info = sessions
        .get({ sessionID: sessionId })
        .pipe(hostError("session.get"))

      const messages = sessions
        .context({ sessionID: sessionId })
        .pipe(hostError("session.context"))

      const [{ parentID }, transcript] = yield* Effect.all([info, messages], {
        concurrency: "unbounded",
      })

      return {
        items: fromSessionMessages(transcript),
        parentId: Option.fromUndefinedOr(parentID),
      }
    })

    return Layer.succeed(Host, Host.of({ openAiCredential, session }))
  }
}

export { Host }

export type { Interface as HostInterface, SessionId, SessionSnapshot }
