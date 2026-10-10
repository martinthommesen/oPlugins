import { Data } from "effect"

/** The parts of a session the reviewer reads, in this plugin's own terms. */
type Item = Data.TaggedEnum<{
  AssistantText: { readonly text: string }
  ShellCommand: { readonly command: string }
  Summary: { readonly text: string }
  ToolCall: {
    readonly id: string
    /** The call's input as JSON text. */
    readonly input: string
    readonly messageId: string
    readonly name: string
  }
  UserMessage: { readonly id: string; readonly text: string }
}>

/** Builds and matches conversation items. */
export default Data.taggedEnum<Item>()
