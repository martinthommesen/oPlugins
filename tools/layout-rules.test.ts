import { describe, expect, it } from "@effect/vitest"
import layout from "./layout.test-support.ts"
import layoutRules from "./layout-rules.ts"

describe("a repository laid out as the ADRs say", () => {
  it("has no layout problems", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(layoutRules.problems(layout.VALID)).toStrictEqual([])
  })

  it("has one line per problem, naming its file", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      layoutRules.problems(layout.withoutFile("libs/demo-kit/AGENTS.md")),
    ).toStrictEqual([
      "libs/demo-kit/AGENTS.md: The file is missing. Add it, to tell agents what the library does and how plugins use it.",
    ])
  })
})
