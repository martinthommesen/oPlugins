import { Option, Record as Rec, Result, Schema } from "effect"
import PackageManifest from "./package-manifest.ts"
import type Snapshot from "./snapshot.ts"

type Files = (typeof Snapshot.Type)["files"]

type Manifest = typeof PackageManifest.Type

/* Line breaks, which a problem's message never holds. */
const LINE_BREAKS = /\s*\n\s*/gu,
  /* One problem, on one line: its file, then what's wrong and what to do. */
  at = (file: string, message: string): string =>
    `${file}: ${message.replaceAll(LINE_BREAKS, " ")}`,
  /* One problem on line `line` of `file`. */
  atLine = (file: string, line: number, message: string): string =>
    at(`${file}:${String(line)}`, message),
  decodeManifest = Schema.decodeResult(PackageManifest),
  /* The text of `file`, or none when the repository lacks it. */
  fileText = (files: Files, file: string): Option.Option<string> =>
    Rec.get(files, file),
  /*
   * The `package.json` at `file`, decoded, or the one problem that stops the
   * checks from reading it.
   */
  manifestAt = (files: Files, file: string): Result.Result<Manifest, string> =>
    Option.match(fileText(files, file), {
      onNone: () =>
        Result.fail(at(file, "The file is missing. Add the package.json.")),
      onSome: (text) =>
        decodeManifest(text).pipe(
          Result.mapError((failure: { readonly message: string }) =>
            at(
              file,
              `The checks can't read the file: ${failure.message}. Correct it.`,
            ),
          ),
        ),
    }),
  /* A value as a problem quotes it, or `missing` when it's absent. */
  quoted = (value: Option.Option<string>): string =>
    Option.match(value, {
      onNone: () => "missing",
      onSome: (text) => `"${text}"`,
    }),
  /* An optional field's value as a problem quotes it. */
  quotedField = (value: string | undefined): string =>
    quoted(Option.fromUndefinedOr(value)),
  /* The problem `message` in `file` when `failed`, else none. */
  reportIf = (
    failed: boolean,
    file: string,
    message: string,
  ): readonly string[] => {
    if (failed) {
      return [at(file, message)]
    }

    return []
  }

/** Reading the snapshot's files, and wording each problem. */
export default Object.freeze({
  at,
  atLine,
  manifestAt,
  quoted,
  quotedField,
  reportIf,
  textOf: fileText,
})
