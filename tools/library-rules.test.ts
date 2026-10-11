import { describe, expect, it } from "@effect/vitest"
import layout from "./layout.test-support.ts"
import libraryRules from "./library-rules.ts"

const FILE = "libs/demo-kit/package.json"

describe("a library", () => {
  it("passes when it's private and documented", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(libraryRules.problems(layout.VALID, "demo-kit")).toStrictEqual([])
  })

  it("isn't named like a plugin", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      libraryRules
        .problems(layout.VALID, "oc-kit")
        .filter((problem) => problem.startsWith("libs/oc-kit: ")),
    ).toStrictEqual([
      'libs/oc-kit: The folder name starts with "oc-", which only plugin names do. Rename the library.',
    ])
  })

  it("has an AGENTS.md", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      libraryRules.problems(
        layout.withoutFile("libs/demo-kit/AGENTS.md"),
        "demo-kit",
      ),
    ).toStrictEqual([
      "libs/demo-kit/AGENTS.md: The file is missing. Add it, to tell agents what the library does and how plugins use it.",
    ])
  })

  it("is private, named, and checked", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const manifest = JSON.stringify({
      name: "demo-kit",
      scripts: { test: "x" },
    })

    expect(
      libraryRules.problems(layout.withFile(FILE, manifest), "demo-kit"),
    ).toStrictEqual([
      `${FILE}: "name" is "demo-kit". Set it to "@oc-lib/demo-kit".`,
      `${FILE}: "private" isn't true, but a library is never published. Set it to true.`,
      `${FILE}: The "typecheck" script is missing. Add it.`,
      `${FILE}: The "lint:effect" script is missing. Add it.`,
    ])
  })
})
