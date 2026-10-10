import { Array as Arr, Option, String as Str, Struct, pipe } from "effect"
import { ConversationItem } from "./conversation.ts"

interface Entry {
  readonly label: string
  readonly text: string
}

interface RenderedEntry extends Entry {
  readonly index: number
}

const MAX_ENTRY_CHARS = 12_000

const MAX_TOOL_INPUT_CHARS = 4000

const MAX_TOOL_RESULT_CHARS = 8000

const FIRST_ENTRY_NUMBER = 1

const EMPTY_LENGTH = 0

const TASK_SHARE = 2

const SEPARATOR = "\n\n"

/**
 * Shortens text past a limit and marks how much was cut.
 * @param {number} limit Maximum characters kept.
 * @param {string} text The text to shorten.
 * @returns {string} At most `limit` characters, including the truncation marker.
 */
const truncate = (limit: number, text: string): string => {
  if (text.length <= limit) {
    return text
  }

  const markerLength = `<truncated omitted_chars="${text.length}" />`.length

  const kept = Math.max(EMPTY_LENGTH, limit - markerLength)

  const marker = `<truncated omitted_chars="${text.length - kept}" />`

  return Str.takeLeft(`${Str.takeLeft(text, kept)}${marker}`, limit)
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

/**
 * Leaves room for the latest entry when the first user message is too large.
 * @param {readonly RenderedEntry[]} entries The conversation, oldest first.
 * @param {RenderedEntry} task The first user message.
 * @param {number} budget Characters available.
 * @returns {number} Characters available for the first user message.
 */
const taskBudget = (
  entries: readonly RenderedEntry[],
  task: RenderedEntry,
  budget: number,
): number => {
  const newestLength = pipe(
    entries,
    Arr.last,
    Option.filter((entry) => entry !== task),
    Option.map((entry) => entry.text.length + SEPARATOR.length),
    Option.getOrElse(() => EMPTY_LENGTH),
  )

  return budget - Math.min(newestLength, Math.floor(budget / TASK_SHARE))
}

/**
 * Keeps the newest run of entries, shortening the latest one if necessary.
 * @param {readonly RenderedEntry[]} entries Candidates, oldest first.
 * @param {number} available Characters available, including separators.
 * @returns {readonly RenderedEntry[]} The kept entries, newest first.
 */
const newestThatFit = (
  entries: readonly RenderedEntry[],
  available: number,
): readonly RenderedEntry[] => {
  const kept: RenderedEntry[] = []

  let remaining = Math.max(EMPTY_LENGTH, available)

  for (const entry of Arr.reverse(entries)) {
    if (
      remaining <= EMPTY_LENGTH ||
      (kept.length > EMPTY_LENGTH && entry.text.length > remaining)
    ) {
      break
    }

    const text = truncate(remaining, entry.text)

    kept.push(pipe(entry, Struct.assign({ text })))

    remaining -= text.length + SEPARATOR.length
  }

  return kept
}

/**
 * Keeps the first user message and the newest entries within the budget.
 * @param {readonly RenderedEntry[]} entries The conversation, oldest first.
 * @param {number} budget Characters available for the entries.
 * @returns {readonly RenderedEntry[]} The kept entries, oldest first.
 */
const fitBudget = (
  entries: readonly RenderedEntry[],
  budget: number,
): readonly RenderedEntry[] => {
  const task = Arr.findFirst(entries, (entry) => entry.label === "user")

  const first = task.pipe(
    Option.map((entry): RenderedEntry => {
      const text = truncate(taskBudget(entries, entry, budget), entry.text)

      return pipe(entry, Struct.assign({ text }))
    }),
  )

  const tail = newestThatFit(
    entries.filter((entry) => entry !== Option.getOrUndefined(task)),
    budget -
      Option.match(first, {
        onNone: () => EMPTY_LENGTH,
        onSome: (entry) => entry.text.length + SEPARATOR.length,
      }),
  )

  return [...Option.toArray(first), ...tail].toSorted(
    (left, right) => left.index - right.index,
  )
}

const renderEntries = (
  items: readonly ConversationItem[],
): readonly RenderedEntry[] =>
  pipe(
    items,
    Arr.map((item, index) => {
      const entry = toEntry(item)

      return {
        index,
        label: entry.label,
        text: `[${index + FIRST_ENTRY_NUMBER}] ${entry.label}: ${truncate(MAX_ENTRY_CHARS, entry.text)}`,
      }
    }),
  )

/**
 * Marks entries omitted from an oversized transcript.
 * @param {number} omitted The number of omitted entries.
 * @returns {string} The marker, or nothing if every entry was kept.
 */
const omissionMarker = (omitted: number): string => {
  if (omitted <= EMPTY_LENGTH) {
    return ""
  }

  return `<truncated omitted_entries="${omitted}" />${SEPARATOR}`
}

/**
 * Budgets rendered entries, including omission markers and separators.
 * @param {readonly RenderedEntry[]} entries The rendered conversation.
 * @param {number} budget Characters available for the transcript.
 * @returns {string} The shortened transcript.
 */
const renderBudgeted = (
  entries: readonly RenderedEntry[],
  budget: number,
): string => {
  const kept = fitBudget(
    entries,
    budget - omissionMarker(entries.length).length,
  )

  const body = kept.map((entry) => entry.text).join(SEPARATOR)

  return truncate(
    budget,
    `${omissionMarker(entries.length - kept.length)}${body}`,
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
  const entries = renderEntries(items)

  const whole = entries.map((entry) => entry.text).join(SEPARATOR)

  if (entries.length === EMPTY_LENGTH) {
    return truncate(budget, "<no transcript entries>")
  }

  if (whole.length <= budget) {
    return whole
  }

  return renderBudgeted(entries, budget)
}

export { renderTranscript, truncate }
