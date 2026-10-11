/** A string literal's value or a comment's text, and the line it starts on. */
interface Token {
  readonly line: number
  readonly text: string
}

const COMMENT_START = "/",
  QUOTE = 1,
  START = 0,
  /*
   * A string literal or a comment, whichever starts first. Matching each
   * whole keeps a `//` in a string from reading as a comment, and a quote in
   * a comment from reading as a string.
   */
  TOKEN =
    /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//gu,
  /* The line that `index` falls on in `text`, counting from 1. */
  lineAt = (text: string, index: number): number =>
    text.slice(START, index).split("\n").length,
  /* Every string literal and comment in `text`, in order. */
  matches = (text: string): readonly Token[] =>
    [...text.matchAll(TOKEN)].map(
      (match: { readonly [START]: string; readonly index: number }) => ({
        line: lineAt(text, match.index),
        text: match[START],
      }),
    ),
  /* Every comment in TypeScript source `text`, delimiters included. */
  readComments = (text: string): readonly Token[] =>
    matches(text).filter((token) => token.text.startsWith(COMMENT_START)),
  /*
   * The value of every string literal in TypeScript source `text`, without
   * its quotes. A template literal counts, substitutions and all.
   */
  readLiterals = (text: string): readonly Token[] =>
    matches(text)
      .filter((token) => !token.text.startsWith(COMMENT_START))
      .map((literal) => ({
        line: literal.line,
        text: literal.text.slice(QUOTE, -QUOTE),
      }))

/** The string literals and comments of TypeScript source text. */
export default Object.freeze({
  comments: readComments,
  stringLiterals: readLiterals,
})
