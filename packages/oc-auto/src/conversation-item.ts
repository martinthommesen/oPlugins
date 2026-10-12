import { Data } from "effect"

/** The parts of a session the reviewer reads, in this plugin's own terms. */
type Item = Data.TaggedEnum<{
  /** Text the agent wrote. */
  AssistantText: { readonly text: string }
  /** A shell command the session's user ran. */
  ShellCommand: { readonly command: string }
  /** A compaction's summary of the messages before it. */
  Summary: { readonly text: string }
  /** A tool call the agent made. */
  ToolCall: {
    readonly id: string
    /** The call's input as JSON text. */
    readonly input: string
    /** The assistant message that made the call. */
    readonly messageId: string
    readonly name: string
  }
  /** A message in the session's user role. */
  UserMessage: { readonly id: string; readonly text: string }
}>

/** Builds and matches conversation items. */
export default Data.taggedEnum<Item>()
