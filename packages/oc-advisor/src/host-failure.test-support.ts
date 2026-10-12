import { Effect, Schema } from "effect"
import { Agent } from "@opencode/plugin/effect"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import support from "./advisor.test-support.ts"

/*
 * Failures as OpenCode 2.0.27 raises them, with the tag and fields of their
 * `Schema.TaggedError` classes: the core's, such as `Session.NotFoundError`
 * (`packages/core/src/session/error.ts`), and `AI.Error` from
 * `@opencode/ai` (`packages/ai/src/schema/errors.ts`).
 */
const NOT_FOUND = Schema.TaggedStruct("Session.NotFoundError", {
    sessionID: Schema.String,
  }).make({ sessionID: support.SESSION_ID }),
  /* Conversation text a host failure may quote, which no record may carry. */
  SECRET = "Transcript: the database password is hunter2",
  /* A model provider's reason to fail: it is limiting requests. */
  SLOW_DOWN = Schema.TaggedStruct("RateLimit", {
    body: Schema.String,
    message: Schema.String,
  }).make({ body: SECRET, message: SECRET }),
  /* The model provider limiting requests, quoting its response. */
  THROTTLED = Schema.TaggedStruct("AI.Error", {
    reason: Schema.TaggedStruct("RateLimit", {
      body: Schema.String,
      message: Schema.String,
    }),
  }).make({ reason: SLOW_DOWN }),
  /** A call of the advisor tool from the consulting session. */
  TOOL_CONTEXT: Tool.Context = {
    agent: Agent.ID.make("build"),
    id: Tool.CallID.make("call_advisor"),
    messageID: SessionMessage.ID.make("msg_consulting"),
    progress: () => Effect.void,
    sessionID: support.SESSION_ID,
  },
  /* A connection that couldn't be authorized, quoting the cause. */
  UNAUTHORIZED = Schema.TaggedStruct("Integration.Authorization", {
    cause: Schema.Defect(),
  }).make({ cause: new Error(SECRET) }),
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
  NOT_FOUND,
  SECRET,
  THROTTLED,
  TOOL_CONTEXT,
  UNAUTHORIZED,
  leaked,
})
