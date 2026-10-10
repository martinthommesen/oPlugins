import {
  Array as Arr,
  Number as Num,
  Option,
  String as Str,
  pipe,
} from "effect"
import { ConversationItem } from "./conversation.ts"

interface Entry {
  readonly label: string
  readonly text: string
}

const MAX_ENTRY_CHARS = 12_000

const MAX_TOOL_INPUT_CHARS = 4000

const MAX_TOOL_RESULT_CHARS = 8000

const FIRST_ENTRY_NUMBER = 1

/**
 * Shortens text past a limit and marks how much was cut.
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

const toEntry = (item: ConversationItem): Entry =>
  ConversationItem.$match(item, {
    AssistantText: ({ text }) => ({ label: "assistant", text }),
    Notice: ({ text }) => ({ label: "notice", text }),
    ShellCommand: ({ command, output }) => ({
      label: "user shell command",
      text: `$ ${command}\n${truncate(MAX_TOOL_RESULT_CHARS, output)}`,
    }),
    SkillLoaded: ({ name }) => ({ label: "skill loaded", text: name }),
    Summary: ({ text }) => ({ label: "summary of earlier conversation", text }),
    ToolCall: ({ input, name, result }) => ({
      label: `assistant tool call ${name}`,
      text: [
        `input: ${truncate(MAX_TOOL_INPUT_CHARS, input)}`,
        `result: ${truncate(MAX_TOOL_RESULT_CHARS, result)}`,
      ].join("\n"),
    }),
    UserMessage: ({ text }) => ({ label: "user", text }),
  })

const entryLength = (entry: Entry): number =>
  entry.label.length + Math.min(entry.text.length, MAX_ENTRY_CHARS)

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
 * Keeps the task's first user message and the newest run of the remaining
 * entries that fits the budget left after it.
 * @param {readonly Entry[]} entries The whole conversation, oldest first.
 * @param {number} budget Characters available for the transcript.
 * @returns {readonly Entry[]} The kept entries, oldest first.
 */
const fitBudget = (
  entries: readonly Entry[],
  budget: number,
): readonly Entry[] => {
  const task = Arr.findFirst(entries, (entry) => entry.label === "user")

  const reserved = Option.match(task, {
    onNone: () => Num.sumAll([]),
    onSome: entryLength,
  })

  const fitting = newestThatFit(
    pipe(
      entries,
      Arr.filter((entry) => Option.getOrUndefined(task) !== entry),
    ),
    budget - reserved,
  )

  return pipe(
    entries,
    Arr.filter(
      (entry) => Option.getOrUndefined(task) === entry || fitting.has(entry),
    ),
  )
}

/**
 * Renders a session's conversation for the advisor, oldest entry first.
 * @param {readonly ConversationItem[]} items The consulting session.
 * @param {number} budget Characters available for the transcript.
 * @returns {string} The transcript text sent to the advisor.
 */
const renderTranscript = (
  items: readonly ConversationItem[],
  budget: number,
): string => {
  const entries = pipe(items, Arr.map(toEntry))

  const kept = fitBudget(entries, budget)

  const lines = pipe(
    kept,
    Arr.map(
      (entry, index) =>
        `[${index + FIRST_ENTRY_NUMBER}] ${entry.label}: ${truncate(MAX_ENTRY_CHARS, entry.text)}`,
    ),
  )

  const body = pipe(
    lines,
    Arr.match({
      onEmpty: () => "<no transcript entries>",
      onNonEmpty: (nonEmpty) => nonEmpty.join("\n\n"),
    }),
  )

  if (kept.length < entries.length) {
    const omitted = entries.length - kept.length

    return `<truncated omitted_entries="${omitted}" />\n\n${body}`
  }

  return body
}

export { renderTranscript, truncate }
