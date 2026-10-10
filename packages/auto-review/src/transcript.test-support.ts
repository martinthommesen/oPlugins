import ConversationItem from "./conversation-item.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Schema } from "effect"
import support from "./testing.test-support.ts"

/** A request to run the tool call in `SESSION`. */
const EVALUATION: PermissionEvaluation = {
    action: "bash",
    effect: "ask",
    resources: ["rm -rf dist"],
    sessionID: support.sessionId("ses_1"),
    source: { id: "call_1", messageID: "msg_2", type: "tool" },
  },
  /** A user's request, the assistant's reply, and the call it made. */
  SESSION = [
    ConversationItem.UserMessage({ id: "msg_1", text: "Clean up the build." }),
    ConversationItem.AssistantText({ text: "Removing the output folder." }),
    ConversationItem.ToolCall({
      id: "call_1",
      input: '{"command":"rm -rf dist"}',
      messageId: "msg_2",
      name: "bash",
    }),
  ],
  decodeJson = Schema.decodeUnknownEffect(
    Schema.fromJsonString(Schema.Unknown),
  ),
  encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown)),
  /** One transcript line, as the reviewer reads it. */
  entryLine = Schema.encodeEffect(
    Schema.fromJsonString(
      Schema.Struct({ label: Schema.String, text: Schema.String }),
    ),
  )

/** The conversation and helpers the transcript tests share. */
export default Object.freeze({
  EVALUATION,
  SESSION,
  decodeJson,
  encodeJson,
  entryLine,
})
