import { Array as Arr, Option } from "effect"
import type Snapshot from "./snapshot.ts"
import layoutFiles from "./layout-files.ts"
import sourceText from "./source-text.ts"

/** A comment line that suppresses a check, and the comment it's in. */
interface Suppression {
  readonly comment: string
  readonly line: number
}

const CODE = /\.[cm]?[jt]sx?$/u,
  DIRECTIVE =
    /^(?:oxlint-disable|eslint-disable|@ts-ignore|@ts-expect-error|@ts-nocheck|@effect-diagnostics)/u,
  /** The one file with the host editor's draft parameter. */
  MODEL_PRICING = "packages/oc-auth/src/model-pricing.ts",
  NEXT = 1,
  /** A comment line's opening `//`, `/*`, or `*`, and the space after it. */
  OPENER = /^(?:\/\/+|\/\*+|\*+)\s*/u,
  /** The suppression for the host editor's draft, which is edited in place. */
  READONLY_DRAFT =
    /^\/\/ oxlint-disable-next-line typescript\/prefer-readonly-parameter-types(?: -- .+)?$/u,
  /** The suppression unicorn/throw-new-error needs above a tagged error. */
  TAGGED_ERROR =
    /^\/\/ oxlint-disable-next-line unicorn\/throw-new-error(?: -- .+)?$/u,
  TAGGED_ERROR_CLASS =
    /^(?:export\s+(?:default\s+)?)?class \w+ extends Schema\.TaggedError</u,
  /* Every comment line in `text` that starts with a suppression directive. */
  allSuppressions = (text: string): readonly Suppression[] =>
    sourceText.comments(text).flatMap((comment) =>
      comment.text.split("\n").flatMap((body, offset) => {
        if (!DIRECTIVE.test(body.trim().replace(OPENER, ""))) {
          return []
        }

        return [{ comment: comment.text.trim(), line: comment.line + offset }]
      }),
    ),
  /* Line `line` of `text`, counting from 1, trimmed. */
  bareLine = (text: string, line: number): string =>
    (text.split("\n")[line - NEXT] ?? "").trim(),
  /*
   * Every suppression in `file` that `AGENTS.md` doesn't allow. It allows
   * two: unicorn/throw-new-error directly above a `Schema.TaggedError`
   * class, and one typescript/prefer-readonly-parameter-types on the host
   * editor's draft in `model-pricing.ts`.
   */
  checkFile = (file: string, text: string): readonly string[] => {
    const all = allSuppressions(text),
      draft = Arr.findFirst(
        all,
        (suppression) =>
          file === MODEL_PRICING && READONLY_DRAFT.test(suppression.comment),
      )

    return all.flatMap((suppression) => {
      const nextLine = bareLine(text, suppression.line + NEXT)

      if (
        (TAGGED_ERROR.test(suppression.comment) &&
          TAGGED_ERROR_CLASS.test(nextLine)) ||
        Option.exists(draft, (allowed) => allowed === suppression)
      ) {
        return []
      }

      return [
        layoutFiles.atLine(
          file,
          suppression.line,
          `"${bareLine(text, suppression.line)}" suppresses a check. Change the code so the check passes, and remove the comment. AGENTS.md lists the only suppressions allowed.`,
        ),
      ]
    })
  },
  /* Every suppression comment in the repository's code that isn't allowed. */
  problems = (snapshot: typeof Snapshot.Type): readonly string[] =>
    Object.entries(snapshot.files).flatMap(
      ([file, text]: readonly [string, string]) => {
        if (!CODE.test(file)) {
          return []
        }

        return checkFile(file, text)
      },
    )

/** The check that code suppresses no check but the two AGENTS.md allows. */
export default Object.freeze({ problems })
