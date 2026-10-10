import { Predicate, Schema, SchemaIssue, String as Str } from "effect"

type Problem = ReturnType<typeof formatProblems>["issues"][number]

type Segment = NonNullable<Problem["path"]>[number]

const TRAILING_PERIOD = /\.$/u,
  formatProblems = SchemaIssue.makeFormatterStandardSchemaV1(),
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
  }

/** The plugin options in `opencode.jsonc` are invalid, so oc-browser did not start. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class InvalidOptions extends Schema.TaggedError<InvalidOptions>()(
  "InvalidOptions",
  { message: Schema.String },
) {
  /* The error for every problem `issue` found, each naming its option. */
  public static readonly fromIssue = (
    issue: SchemaIssue.Issue,
  ): InvalidOptions =>
    InvalidOptions.make({
      message: [
        "oc-browser did not start because its options in opencode.jsonc are invalid.",
        ...formatProblems(issue).issues.map((problem) =>
          problemSentence(problem),
        ),
        "Correct the options, then restart OpenCode.",
      ].join(" "),
    })
}

export default InvalidOptions
