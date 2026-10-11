import { describe, expect, it } from "@effect/vitest"
import layout from "./layout.test-support.ts"
import suppressionRules from "./suppression-rules.ts"

/*
 * The fixtures build each directive from two strings, so this file holds no
 * comment-like text a scan of the repository could mistake for one.
 */
const AFTER_LOCATION = /: .*$/u,
  DISABLE_NEXT = ["oxlint", "disable-next-line"].join("-"),
  FILE = "packages/oc-demo/src/demo.ts",
  MODEL_PRICING = "packages/oc-auth/src/model-pricing.ts",
  /* The suppression problems with `file` holding `lines`. */
  problemsIn = (file: string, lines: readonly string[]): readonly string[] =>
    suppressionRules.problems(layout.withFile(file, lines.join("\n")))

describe("a tagged error's suppression", () => {
  it("is allowed directly above the class", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsIn(FILE, [
        `// ${DISABLE_NEXT} unicorn/throw-new-error -- It builds a class.`,
        "class DemoError extends Schema.TaggedError<DemoError>()(",
      ]),
    ).toStrictEqual([])
  })

  it("isn't allowed anywhere else", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsIn(FILE, [
        `// ${DISABLE_NEXT} unicorn/throw-new-error`,
        "const demo = 1",
      ]),
    ).toStrictEqual([
      `${FILE}:1: "// ${DISABLE_NEXT} unicorn/throw-new-error" suppresses a check. Change the code so the check passes, and remove the comment; AGENTS.md lists the only suppressions allowed.`,
    ])
  })
})

describe("the host editor draft's suppression", () => {
  it("is allowed once in model-pricing.ts", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsIn(MODEL_PRICING, [
        `  // ${DISABLE_NEXT} typescript/prefer-readonly-parameter-types -- A draft.`,
        "  zeroCost = (draft: { cost: unknown[] }): void => {",
        `  // ${DISABLE_NEXT} typescript/prefer-readonly-parameter-types`,
      ]).map((problem) => problem.replace(AFTER_LOCATION, "")),
    ).toStrictEqual([`${MODEL_PRICING}:3`])
  })

  it("isn't allowed in any other file", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsIn(FILE, [
        `// ${DISABLE_NEXT} typescript/prefer-readonly-parameter-types`,
      ]).map((problem) => problem.replace(AFTER_LOCATION, "")),
    ).toStrictEqual([`${FILE}:1`])
  })
})

describe("every other suppression", () => {
  it("is a problem on the line it's on", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsIn(FILE, [
        "const one = 1",
        ["// @ts", "ignore"].join("-"),
        ["/* eslint", "disable */"].join("-"),
        "/**",
        ` * ${["@effect", "diagnostics"].join("-")} floatingEffect:off`,
        " */",
      ]).map((problem) => problem.replace(AFTER_LOCATION, "")),
    ).toStrictEqual([`${FILE}:2`, `${FILE}:3`, `${FILE}:5`])
  })

  it("isn't read from a string", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsIn(FILE, [`const text = "// ${DISABLE_NEXT} anything"`]),
    ).toStrictEqual([])
  })

  it("is only looked for in code", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsIn("packages/oc-demo/README.md", [`// ${DISABLE_NEXT} anything`]),
    ).toStrictEqual([])
  })
})
