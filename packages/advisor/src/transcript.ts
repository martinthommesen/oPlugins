import { Array as Arr, Option, String as Str, Struct, pipe } from "effect"
import conversation from "./conversation.ts"

type ConversationItem = ReturnType<
  typeof conversation.fromSessionMessages
>[number]

interface Entry {
  readonly label: string
  readonly text: string
}

interface RenderedEntry extends Entry {
  readonly index: number
}

const EMPTY_LENGTH = 0,
  FIRST_ENTRY_NUMBER = 1,
  MAX_ENTRY_CHARS = 12_000,
  MAX_TOOL_INPUT_CHARS = 4000,
  MAX_TOOL_RESULT_CHARS = 8000,
  SEPARATOR = "\n\n",
  TASK_SHARE = 2,
  /*
   * Shortens text past a limit and marks how much was cut. The result has at
   * most `limit` characters, including the truncation marker.
   */
  clip = (limit: number, text: string): string => {
    if (text.length <= limit) {
      return text
    }

    const estimate = `<truncated omitted_chars="${text.length}" />`.length,
      kept = Math.max(EMPTY_LENGTH, limit - estimate),
      marker = `<truncated omitted_chars="${text.length - kept}" />`

    return Str.takeLeft(`${Str.takeLeft(text, kept)}${marker}`, limit)
  },
  entryOf = (item: ConversationItem): Entry =>
    conversation.ConversationItem.$match(item, {
      AssistantText: ({ text }) => ({ label: "assistant", text }),
      Notice: ({ text }) => ({ label: "notice", text }),
      ShellCommand: ({ command, output }) => ({
        label: "user shell command",
        text: `$ ${command}\n${clip(MAX_TOOL_RESULT_CHARS, output)}`,
      }),
      SkillLoaded: ({ name }) => ({ label: "skill loaded", text: name }),
      Summary: ({ text }) => ({
        label: "summary of earlier conversation",
        text,
      }),
      ToolCall: ({ input, name, result }) => ({
        label: `assistant tool call ${name}`,
        text: [
          `input: ${clip(MAX_TOOL_INPUT_CHARS, input)}`,
          `result: ${clip(MAX_TOOL_RESULT_CHARS, result)}`,
        ].join("\n"),
      }),
      UserMessage: ({ text }) => ({ label: "user", text }),
    }),
  /*
   * The characters available for the first user message, leaving room for
   * the latest entry when the first user message is too large.
   */
  firstBudget = (
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
  },
  /*
   * Keeps the newest run of entries within `available` characters, separators
   * included, shortening the latest one if necessary. Newest first.
   */
  newestThatFit = (
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

      const text = clip(remaining, entry.text)

      kept.push(pipe(entry, Struct.assign({ text })))

      remaining -= text.length + SEPARATOR.length
    }

    return kept
  },
  /* Marks entries omitted from an oversized transcript, or nothing if every entry was kept. */
  omissionMarker = (omitted: number): string => {
    if (omitted <= EMPTY_LENGTH) {
      return ""
    }

    return `<truncated omitted_entries="${omitted}" />${SEPARATOR}`
  },
  /* Keeps the first user message and the newest entries within the budget, oldest first. */
  pickEntries = (
    entries: readonly RenderedEntry[],
    budget: number,
  ): readonly RenderedEntry[] => {
    const candidate = Arr.findFirst(entries, (entry) => entry.label === "user"),
      first = candidate.pipe(
        Option.map((entry): RenderedEntry => {
          const text = clip(firstBudget(entries, entry, budget), entry.text)

          return pipe(entry, Struct.assign({ text }))
        }),
      ),
      tail = newestThatFit(
        entries.filter((entry) => entry !== Option.getOrUndefined(candidate)),
        budget -
          Option.match(first, {
            onNone: () => EMPTY_LENGTH,
            onSome: (entry) => entry.text.length + SEPARATOR.length,
          }),
      )

    return [...Option.toArray(first), ...tail].toSorted(
      (left, right) => left.index - right.index,
    )
  },
  /* Budgets rendered entries, including omission markers and separators. */
  renderBudgeted = (
    entries: readonly RenderedEntry[],
    budget: number,
  ): string => {
    const kept = pickEntries(
        entries,
        budget - omissionMarker(entries.length).length,
      ),
      text = kept.map((entry) => entry.text).join(SEPARATOR)

    return clip(
      budget,
      `${omissionMarker(entries.length - kept.length)}${text}`,
    )
  },
  renderEntries = (
    items: readonly ConversationItem[],
  ): readonly RenderedEntry[] =>
    pipe(
      items,
      Arr.map((item, index) => {
        const entry = entryOf(item)

        return {
          index,
          label: entry.label,
          text: `[${index + FIRST_ENTRY_NUMBER}] ${entry.label}: ${clip(MAX_ENTRY_CHARS, entry.text)}`,
        }
      }),
    ),
  /* Renders a session's conversation for the advisor, oldest entry first. */
  renderTranscript = (
    items: readonly ConversationItem[],
    budget: number,
  ): string => {
    const entries = renderEntries(items),
      whole = entries.map((entry) => entry.text).join(SEPARATOR)

    if (entries.length === EMPTY_LENGTH) {
      return clip(budget, "<no transcript entries>")
    }

    if (whole.length <= budget) {
      return whole
    }

    return renderBudgeted(entries, budget)
  }

/** The transcript of a session's conversation that the advisor reads. */
export default Object.freeze({ renderTranscript, truncate: clip })
