import {
  Array as Arr,
  Effect,
  Number as Num,
  Option,
  Predicate,
  Schema,
  String as Str,
  pipe,
} from "effect"
import ContextUnavailable from "./context-unavailable-error.ts"
import ConversationItem from "./conversation-item.ts"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"

/** Who wrote a session's user messages, which decides their authority. */
type Speaker = "delegator" | "user"

type Item = Parameters<typeof ConversationItem.$match>[typeof FIRST]

type ToolCall = ReturnType<typeof ConversationItem.ToolCall>

interface Entry {
  readonly label: string
  readonly text: string
  /** Trusted entries can authorize actions and are never dropped. */
  readonly trusted: boolean
}

const CalledTool = Schema.Struct({ input: Schema.String, name: Schema.String }),
  FIRST = 0,
  MAX_ACTION_CHARS = 8000,
  MAX_ENTRY_CHARS = 2000,
  MAX_TOOL_INPUT_CHARS = 1000,
  NO_CHARS = 0,
  /** The planned action as the reviewer reads it, in this key order. */
  PlannedAction = Schema.fromJsonString(
    Schema.Struct({
      action: Schema.String,
      metadata: Schema.optionalKey(Schema.Unknown),
      resources: Schema.Array(Schema.String),
      tool_call: Schema.optional(CalledTool),
    }),
  ),
  SECTION_OVERHEAD_CHARS = 512,
  SPEAKER_LABELS = {
    delegator: "delegating agent",
    user: "user",
  } as const satisfies Record<Speaker, string>,
  TRANSCRIPT_BUDGET_CHARS = 48_000,
  /* `text` cut to `limit` characters, with a marker saying how many were cut. */
  clip = (limit: number, text: string): string => {
    if (text.length <= limit) {
      return text
    }

    const omitted = text.length - limit

    return `${Str.takeLeft(text, limit)}<truncated omitted_chars="${omitted}" />`
  },
  /* The newest user message, which identifies the current turn. */
  currentTurn = (items: readonly Item[]): Option.Option<string> =>
    pipe(
      items,
      Arr.findLast(ConversationItem.$is("UserMessage")),
      Option.map((message) => message.id),
    ),
  /* One transcript line: the entry quoted as JSON. */
  entryJson = (entry: Entry): string =>
    JSON.stringify({ label: entry.label, text: entry.text }),
  /* The characters one entry takes in the transcript, newline included. */
  entryLength = (entry: Entry): number => entryJson(entry).length + "\n".length,
  /* The call in `items` that raised `evaluation`, when it names one. */
  findToolCall = (
    items: readonly Item[],
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
    ),
  /* The newest of `entries` that fit in `available` characters. */
  fitNewest = (
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
  },
  /*
   * Every trusted entry, and the newest untrusted ones that fit beside them.
   * Trusted entries are never dropped, so when they alone exceed the budget
   * the review cannot go ahead.
   */
  fitWithinBudget = Effect.fn("Transcript.fitBudget")(function* fitBudget(
    entries: readonly Entry[],
  ) {
    const fixed = pipe(
        entries,
        Arr.filter((entry) => entry.trusted),
      ),
      fixedChars = pipe(fixed, Arr.map(entryLength), Num.sumAll),
      spare = TRANSCRIPT_BUDGET_CHARS - SECTION_OVERHEAD_CHARS - fixedChars,
      untrusted = pipe(
        entries,
        Arr.filter((entry) => !entry.trusted),
      )

    if (spare < NO_CHARS) {
      return yield* ContextUnavailable.make({
        reason:
          "The user's messages exceed the reviewer context limit. They were not truncated.",
      })
    }

    return new Set([...fixed, ...fitNewest(untrusted, spare)])
  }),
  /* A user message's text, cut only when an agent wrote it. */
  messageText = (speaker: Speaker, text: string): string => {
    if (speaker === "user") {
      return text
    }

    return clip(MAX_ENTRY_CHARS, text)
  },
  /* One conversation item as a labelled transcript entry. */
  quoteItem =
    (speaker: Speaker) =>
    (item: Item): Entry =>
      ConversationItem.$match(item, {
        AssistantText: ({ text }) => ({
          label: "assistant",
          text: clip(MAX_ENTRY_CHARS, text),
          trusted: false,
        }),
        ShellCommand: ({ command }) => ({
          label: `${SPEAKER_LABELS[speaker]} shell command`,
          text: messageText(speaker, command),
          trusted: speaker === "user",
        }),
        Summary: ({ text }) => ({
          label: "summary of earlier conversation",
          text: clip(MAX_ENTRY_CHARS, text),
          trusted: false,
        }),
        ToolCall: ({ input, name }) => ({
          label: `assistant tool call ${name}`,
          text: clip(MAX_TOOL_INPUT_CHARS, input),
          trusted: false,
        }),
        UserMessage: ({ text }) => ({
          label: SPEAKER_LABELS[speaker],
          text: messageText(speaker, text),
          trusted: speaker === "user",
        }),
      }),
  /*
   * The action awaiting approval, as JSON, with the tool call that raised
   * it. An action the reviewer would only see part of is not reviewed.
   */
  renderPlannedAction = Effect.fn("Transcript.renderPlannedAction")(
    function* renderPlannedAction(
      items: readonly Item[],
      evaluation: PermissionEvaluation,
    ) {
      const call = Option.map(findToolCall(items, evaluation), (tool) => ({
        input: tool.input,
        name: tool.name,
      }))

      if (Predicate.isNotUndefined(evaluation.source) && Option.isNone(call)) {
        return yield* ContextUnavailable.make({
          reason:
            "OpenCode could not provide the tool call that raised this permission request.",
        })
      }

      return yield* Schema.encodeEffect(PlannedAction)({
        action: evaluation.action,
        metadata: evaluation.metadata,
        resources: evaluation.resources,
        tool_call: Option.getOrUndefined(call),
      }).pipe(
        Effect.orDie,
        Effect.filterOrFail(
          (action) => action.length <= MAX_ACTION_CHARS,
          () =>
            ContextUnavailable.make({
              reason:
                "The planned action exceeds the reviewer context limit. It was not truncated.",
            }),
        ),
      )
    },
  ),
  /* The selected entries, one per line, marking how many were left out. */
  renderSection = (
    entries: readonly Entry[],
    selected: Readonly<Pick<ReadonlySet<Entry>, "has">>,
  ): string => {
    const kept = pipe(
        entries,
        Arr.filter((entry) => selected.has(entry)),
      ),
      lines = pipe(kept, Arr.map(entryJson))

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
  },
  /*
   * The conversation the reviewer reads. A subagent's transcript also shows
   * the user's own messages from the root conversation, because only those
   * can authorize its actions.
   */
  renderTranscript = Effect.fn("Transcript.renderTranscript")(
    function* renderTranscript(
      items: readonly Item[],
      root: Option.Option<readonly Item[]>,
    ) {
      const convert = Option.match(root, {
          onNone: () => quoteItem("user"),
          onSome: () => quoteItem("delegator"),
        }),
        entries = pipe(items, Arr.map(convert)),
        rootEntries = Option.match(root, {
          onNone: () => [],
          onSome: (rootItems) =>
            pipe(
              rootItems,
              Arr.map(quoteItem("user")),
              Arr.filter((entry) => entry.trusted),
            ),
        }),
        selected = yield* fitWithinBudget([...rootEntries, ...entries])

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

/** Renders the evidence a reviewer reads. */
export default Object.freeze({
  currentTurn,
  renderPlannedAction,
  renderTranscript,
  truncate: clip,
})
