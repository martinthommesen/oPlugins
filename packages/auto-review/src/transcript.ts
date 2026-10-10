import {
  Array as Arr,
  Effect,
  Number as Num,
  Option,
  String as Str,
  pipe,
} from "effect"
import { ContextUnavailable } from "./errors/context-unavailable.ts"
import { ConversationItem } from "./conversation.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"

/** Who wrote a session's user messages, which decides their authority. */
type Speaker = "delegator" | "user"

type ToolCall = Extract<ConversationItem, { readonly _tag: "ToolCall" }>

interface Entry {
  readonly label: string
  readonly text: string
  /** Trusted entries can authorize actions and are never dropped. */
  readonly trusted: boolean
}

const MAX_ENTRY_CHARS = 2000

const MAX_TOOL_INPUT_CHARS = 1000

const MAX_ACTION_CHARS = 8000

const TRANSCRIPT_BUDGET_CHARS = 48_000

const SECTION_OVERHEAD_CHARS = 512

const NO_CHARS = 0

const speakerLabel = {
  delegator: "delegating agent",
  user: "user",
} as const satisfies Record<Speaker, string>

const truncate = (limit: number, text: string): string => {
  if (text.length <= limit) {
    return text
  }

  const omitted = text.length - limit

  return `${Str.takeLeft(text, limit)}<truncated omitted_chars="${omitted}" />`
}

const speakerText = (speaker: Speaker, text: string): string => {
  if (speaker === "user") {
    return text
  }

  return truncate(MAX_ENTRY_CHARS, text)
}

const toEntry =
  (speaker: Speaker) =>
  (item: ConversationItem): Entry =>
    ConversationItem.$match(item, {
      AssistantText: ({ text }) => ({
        label: "assistant",
        text: truncate(MAX_ENTRY_CHARS, text),
        trusted: false,
      }),
      ShellCommand: ({ command }) => ({
        label: `${speakerLabel[speaker]} shell command`,
        text: speakerText(speaker, command),
        trusted: speaker === "user",
      }),
      Summary: ({ text }) => ({
        label: "summary of earlier conversation",
        text: truncate(MAX_ENTRY_CHARS, text),
        trusted: false,
      }),
      ToolCall: ({ input, name }) => ({
        label: `assistant tool call ${name}`,
        text: truncate(MAX_TOOL_INPUT_CHARS, input),
        trusted: false,
      }),
      UserMessage: ({ text }) => ({
        label: speakerLabel[speaker],
        text: speakerText(speaker, text),
        trusted: speaker === "user",
      }),
    })

const renderEntry = (entry: Entry): string =>
  JSON.stringify({ label: entry.label, text: entry.text })

const entryLength = (entry: Entry): number =>
  renderEntry(entry).length + "\n".length

const newestThatFit = (
  entries: readonly Entry[],
  available: number,
): ReadonlySet<Entry> => {
  const kept = new Set<Entry>()

  let used = NO_CHARS

  for (const entry of Arr.reverse(entries)) {
    used += entryLength(entry)

    if (used > available) {
      break
    }

    kept.add(entry)
  }

  return kept
}

const fitBudget = Effect.fn("Transcript.fitBudget")(function* fitBudget(
  entries: readonly Entry[],
) {
  const trusted = pipe(
    entries,
    Arr.filter((entry) => entry.trusted),
  )

  const required = pipe(trusted, Arr.map(entryLength), Num.sumAll)
  const available = TRANSCRIPT_BUDGET_CHARS - SECTION_OVERHEAD_CHARS - required

  if (available < NO_CHARS) {
    return yield* new ContextUnavailable({
      reason:
        "The user's messages exceed the reviewer context limit. They were not truncated.",
    })
  }

  const fitting = newestThatFit(
    pipe(
      entries,
      Arr.filter((entry) => !entry.trusted),
    ),
    available,
  )

  return new Set([...trusted, ...fitting])
})

const renderSection = (
  entries: readonly Entry[],
  selected: Readonly<Pick<ReadonlySet<Entry>, "has">>,
): string => {
  const kept = pipe(
    entries,
    Arr.filter((entry) => selected.has(entry)),
  )

  const lines = pipe(kept, Arr.map(renderEntry))

  if (kept.length < entries.length) {
    const omitted = entries.length - kept.length

    return [`<truncated omitted_entries="${omitted}" />`, ...lines].join("\n")
  }

  return pipe(
    lines,
    Arr.match({
      onEmpty: () => "<no transcript entries>",
      onNonEmpty: (nonEmpty) => nonEmpty.join("\n"),
    }),
  )
}

const renderTranscript = Effect.fn("Transcript.renderTranscript")(
  function* renderTranscript(
    items: readonly ConversationItem[],
    root: Option.Option<readonly ConversationItem[]>,
  ) {
    const rootEntries = Option.match(root, {
      onNone: () => [],
      onSome: (rootItems) =>
        pipe(
          rootItems,
          Arr.map(toEntry("user")),
          Arr.filter((entry) => entry.trusted),
        ),
    })

    const convert = Option.match(root, {
      onNone: () => toEntry("user"),
      onSome: () => toEntry("delegator"),
    })

    const entries = pipe(items, Arr.map(convert))
    const selected = yield* fitBudget([...rootEntries, ...entries])

    if (Option.isNone(root)) {
      return renderSection(entries, selected)
    }

    return [
      "## Root conversation (the user's own messages)",
      renderSection(rootEntries, selected),
      "",
      "## Subagent conversation (its user messages come from the delegating agent)",
      renderSection(entries, selected),
    ].join("\n")
  },
)

const findToolCall = (
  items: readonly ConversationItem[],
  evaluation: PermissionEvaluation,
): Option.Option<ToolCall> =>
  Option.fromUndefinedOr(evaluation.source).pipe(
    Option.flatMap((source) =>
      pipe(
        items,
        Arr.filter(ConversationItem.$is("ToolCall")),
        Arr.findLast(
          (call) =>
            call.id === source.id && call.messageId === source.messageID,
        ),
      ),
    ),
  )

const renderPlannedAction = Effect.fn("Transcript.renderPlannedAction")(
  function* renderPlannedAction(
    items: readonly ConversationItem[],
    evaluation: PermissionEvaluation,
  ) {
    const call = Option.map(findToolCall(items, evaluation), (tool) => ({
      input: tool.input,
      name: tool.name,
    }))

    if (evaluation.source && Option.isNone(call)) {
      return yield* new ContextUnavailable({
        reason:
          "OpenCode could not provide the tool call that raised this permission request.",
      })
    }

    const action = JSON.stringify({
      action: evaluation.action,
      metadata: evaluation.metadata,
      resources: evaluation.resources,
      tool_call: Option.getOrUndefined(call),
    })

    if (action.length > MAX_ACTION_CHARS) {
      return yield* new ContextUnavailable({
        reason:
          "The planned action exceeds the reviewer context limit. It was not truncated.",
      })
    }

    return action
  },
)

const currentTurn = (
  items: readonly ConversationItem[],
): Option.Option<string> =>
  pipe(
    items,
    Arr.findLast(ConversationItem.$is("UserMessage")),
    Option.map((message) => message.id),
  )

export { currentTurn, renderPlannedAction, renderTranscript, truncate }

export { ContextUnavailable } from "./errors/context-unavailable.ts"
