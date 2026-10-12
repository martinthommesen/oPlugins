import { Effect, Schema } from "effect"
import { Agent } from "@opencode/plugin/effect"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import support from "./advisor.test-support.ts"

/* Conversation text a host failure may quote, which no record may carry. */
const SECRET = "Transcript: the database password is hunter2",
  /** A call of the advisor tool from the consulting session. */
  TOOL_CONTEXT: Tool.Context = {
    agent: Agent.ID.make("build"),
    id: Tool.CallID.make("call_advisor"),
    messageID: SessionMessage.ID.make("msg_consulting"),
    progress: () => Effect.void,
    sessionID: support.SESSION_ID,
  },
  /* A structured host failure tagged `tag` that quotes the conversation. */
  failure = (
    tag: string,
  ): { readonly _tag: string; readonly message: string } =>
    Schema.TaggedStruct(tag, { message: Schema.String }).make({
      message: SECRET,
    }),
  /** Whether any record logged so far quotes the conversation. */
  leaked = Effect.gen(function* leaked() {
    const logs = yield* CapturedLogs,
      text = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(
        yield* logs.records,
      ).pipe(Effect.orDie)

    return text.includes(SECRET)
  })

/** Host failures that quote the conversation, and how to check the log. */
export default Object.freeze({
  NOT_FOUND: failure("SessionNotFoundError"),
  SECRET,
  TOOL_CONTEXT,
  UNAUTHORIZED: failure("UnauthorizedError"),
  UNAVAILABLE: failure("ServiceUnavailableError"),
  leaked,
})
