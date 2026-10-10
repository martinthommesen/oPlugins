import {
  Array as Arr,
  Number as Num,
  Option,
  String as Str,
  pipe,
} from "effect"
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

const FIRST_ENTRY_NUMBER = 1

const speakerLabel = {
  delegator: "delegating agent",
  user: "user",
} as const satisfies Record<Speaker, string>

/**
 * Shortens text past a limit, marking the cut the way Codex's policy expects.
 * @param {number} limit Maximum characters kept.
 * @param {string} text The text to shorten.
 * @returns {string} `text`, or its prefix followed by a truncation marker.
 */
const truncate = (limit: number, text: string): string => {
  if (text.length <= limit) {
    return text
  }

  const omitted = text.length - limit

  return `${Str.takeLeft(text, limit)}<truncated omitted_chars="${omitted}" />`
}

/**
 * Converts one conversation item into a transcript entry.
 * @param {Speaker} speaker Who wrote the session's user messages.
 * @returns {(item: ConversationItem) => Entry} The converter.
 */
const toEntry =
  (speaker: Speaker) =>
  (item: ConversationItem): Entry =>
    ConversationItem.$match(item, {
      AssistantText: ({ text }) => ({
        label: "assistant",
        text,
        trusted: false,
      }),
      ShellCommand: ({ command }) => ({
        label: `${speakerLabel[speaker]} shell command`,
        text: command,
        trusted: speaker === "user",
      }),
      Summary: ({ text }) => ({
        label: "summary of earlier conversation",
        text,
        trusted: false,
      }),
      ToolCall: ({ input, name }) => ({
        label: `assistant tool call ${name}`,
        text: truncate(MAX_TOOL_INPUT_CHARS, input),
        trusted: false,
      }),
      UserMessage: ({ text }) => ({
        label: speakerLabel[speaker],
        text,
        trusted: speaker === "user",
      }),
    })

const entryLength = (entry: Entry): number =>
  entry.label.length + entry.text.length

/**
 * Picks the newest run of entries whose combined length fits a budget.
 * @param {readonly Entry[]} entries Candidates, oldest first.
 * @param {number} available Characters available.
 * @returns {ReadonlySet<Entry>} The entries that fit.
 */
const newestThatFit = (
  entries: readonly Entry[],
  available: number,
): ReadonlySet<Entry> => {
  const kept = new Set<Entry>()

  let used = Num.sumAll([])

  for (const entry of Arr.reverse(entries)) {
    used += entryLength(entry)

    if (used > available) {
      break
    }

    kept.add(entry)
  }

  return kept
}

/**
 * Keeps every trusted entry and the newest run of untrusted entries that fits
 * the budget left after them.
 * @param {readonly Entry[]} entries The full section, oldest first.
 * @returns {readonly Entry[]} The kept entries, oldest first.
 */
const fitBudget = (entries: readonly Entry[]): readonly Entry[] => {
  const trusted = pipe(
    entries,
    Arr.filter((entry) => entry.trusted),
  )

  const required = pipe(trusted, Arr.map(entryLength), Num.sumAll)

  const fitting = newestThatFit(
    pipe(
      entries,
      Arr.filter((entry) => !entry.trusted),
    ),
    TRANSCRIPT_BUDGET_CHARS - required,
  )

  return pipe(
    entries,
    Arr.filter((entry) => entry.trusted || fitting.has(entry)),
  )
}

/**
 * Renders a transcript section, oldest entry first.
 * @param {readonly Entry[]} entries Entries before budgeting.
 * @returns {string} The rendered section.
 */
const renderSection = (entries: readonly Entry[]): string => {
  const kept = fitBudget(entries)

  const lines = pipe(
    kept,
    Arr.map(
      (entry, index) =>
        `[${index + FIRST_ENTRY_NUMBER}] ${entry.label}: ${truncate(MAX_ENTRY_CHARS, entry.text)}`,
    ),
  )

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

/**
 * Renders the conversation that led to a permission request.
 * @param {readonly ConversationItem[]} items The requesting session.
 * @param {Option.Option<readonly ConversationItem[]>} root The root session,
 * when the request comes from a subagent.
 * @returns {string} The transcript text sent to the reviewer.
 */
const renderTranscript = (
  items: readonly ConversationItem[],
  root: Option.Option<readonly ConversationItem[]>,
): string =>
  Option.match(root, {
    onNone: () => pipe(items, Arr.map(toEntry("user")), renderSection),
    onSome: (rootItems) =>
      [
        "## Root conversation (the user's own messages)",
        pipe(
          rootItems,
          Arr.map(toEntry("user")),
          Arr.filter((entry) => entry.trusted),
          renderSection,
        ),
        "",
        "## Subagent conversation (its user messages come from the delegating agent)",
        pipe(items, Arr.map(toEntry("delegator")), renderSection),
      ].join("\n"),
  })

/**
 * Finds the tool call that raised a permission request.
 * @param {readonly ConversationItem[]} items The requesting session.
 * @param {PermissionEvaluation} evaluation The permission request.
 * @returns {Option.Option<ToolCall>} The call, when the transcript has it.
 */
const findToolCall = (
  items: readonly ConversationItem[],
  evaluation: PermissionEvaluation,
): Option.Option<ToolCall> =>
  Option.fromUndefinedOr(evaluation.source).pipe(
    Option.flatMap((source) =>
      pipe(
        items,
        Arr.filter(ConversationItem.$is("ToolCall")),
        Arr.findLast((call) => call.id === source.id),
      ),
    ),
  )

/**
 * Renders the action awaiting approval as JSON.
 * @param {readonly ConversationItem[]} items The requesting session.
 * @param {PermissionEvaluation} evaluation The permission request.
 * @returns {string} The planned action sent to the reviewer.
 */
const renderPlannedAction = (
  items: readonly ConversationItem[],
  evaluation: PermissionEvaluation,
): string => {
  const call = Option.map(findToolCall(items, evaluation), (tool) => ({
    input: tool.input,
    name: tool.name,
  }))

  const action = JSON.stringify({
    action: evaluation.action,
    metadata: evaluation.metadata,
    resources: evaluation.resources,
    tool_call: Option.getOrUndefined(call),
  })

  return truncate(MAX_ACTION_CHARS, action)
}

/**
 * Identifies the current turn: the newest user message in the session.
 * @param {readonly ConversationItem[]} items The requesting session.
 * @returns {Option.Option<string>} The message id, when there is one.
 */
const currentTurn = (
  items: readonly ConversationItem[],
): Option.Option<string> =>
  pipe(
    items,
    Arr.findLast(ConversationItem.$is("UserMessage")),
    Option.map((message) => message.id),
  )

export { currentTurn, renderPlannedAction, renderTranscript, truncate }
