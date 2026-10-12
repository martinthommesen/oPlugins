import {
  Array as Arr,
  Match,
  Predicate,
  Schema,
  SchemaIssue,
  String as Str,
} from "effect"

type Problem = ReturnType<
  ReturnType<typeof SchemaIssue.makeFormatterStandardSchemaV1>
>["issues"][number]

type Segment = NonNullable<Problem["path"]>[number]

const TRAILING_PERIOD = /\.$/u,
  formatLeaf = SchemaIssue.makeFormatterDefault(),
  /* The name of one step on the path to a problem: an option's name. */
  optionName = (segment: Segment): string => {
    if (Predicate.isPropertyKey(segment)) {
      return String(segment)
    }

    return String(segment.key)
  },
  /* One problem as a sentence that starts with the option it concerns. */
  problemSentence = (problem: Problem): string => {
    const option = (problem.path ?? [])
        .map((segment) => optionName(segment))
        .join("."),
      sentence = `${problem.message.replace(TRAILING_PERIOD, "")}.`

    if (Str.isEmpty(option)) {
      return sentence
    }

    return `${option}: ${sentence}`
  },
  /* What is wrong with an option `plugin` does not know: the ones it does. */
  unknownOption = (plugin: string, known: readonly string[]): string =>
    Arr.match(known, {
      onEmpty: () => `Unknown option (${plugin} has no options)`,
      onNonEmpty: (names) => `Unknown option (known: ${names.join(", ")})`,
    })

/**
 * A plugin's options in `opencode.jsonc` are invalid, so the plugin didn't
 * start. The message names every invalid or unknown option and what's wrong
 * with it, and never the value it was given.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class PluginOptionsError extends Schema.TaggedError<PluginOptionsError>()(
  "PluginOptionsError",
  { message: Schema.String },
) {
  /*
   * The error for every problem `issue` found in the options of `plugin`,
   * whose options are named `known`.
   */
  public static readonly fromIssue = (
    plugin: string,
    known: readonly string[],
    issue: SchemaIssue.Issue,
  ): PluginOptionsError => {
    const writeProblems = SchemaIssue.makeFormatterStandardSchemaV1({
      leafHook: (leaf: SchemaIssue.Issue) =>
        Match.value(leaf).pipe(
          Match.tag("UnexpectedKey", () => unknownOption(plugin, known)),
          Match.orElse((other: SchemaIssue.Issue) => formatLeaf(other)),
        ),
    })

    return PluginOptionsError.make({
      message: [
        `${plugin} did not start because its options in opencode.jsonc are invalid.`,
        ...writeProblems(issue).issues.map((problem) =>
          problemSentence(problem),
        ),
        "Correct the options, then restart OpenCode.",
      ].join(" "),
    })
  }
}

export default PluginOptionsError
