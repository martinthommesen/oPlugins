import { describe, expect, it } from "@effect/vitest"
import sourceText from "./source-text.ts"

const SOURCE = [
  'const url = "https://example.com/a" // A comment with "quotes".',
  "/* A block",
  "   comment */ const name = 'OC_DEMO_DIR'",
  "const template = `OC_DEMO_TEMPLATE`",
  "",
].join("\n")

describe("a source file's string literals", () => {
  it("are every quoted string, without quotes", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(sourceText.stringLiterals(SOURCE)).toStrictEqual([
      { line: 1, text: "https://example.com/a" },
      { line: 3, text: "OC_DEMO_DIR" },
      { line: 4, text: "OC_DEMO_TEMPLATE" },
    ])
  })
})

describe("a source file's comments", () => {
  it("are every comment, with the line it starts on", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(sourceText.comments(SOURCE)).toStrictEqual([
      { line: 1, text: '// A comment with "quotes".' },
      { line: 2, text: "/* A block\n   comment */" },
    ])
  })
})
