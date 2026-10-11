import { describe, expect, it } from "@effect/vitest"
import catalogRules from "./catalog-rules.ts"
import layout from "./layout.test-support.ts"

const HOST = "packages/oc-demo/node_modules/@opencode/plugin/package.json",
  WORKSPACE = "pnpm-workspace.yaml"

describe("the catalog's effect pins", () => {
  it("pass when they equal the host's", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(catalogRules.problems(layout.VALID)).toStrictEqual([])
  })

  it("equal the effect version the host depends on", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const workspace = [
      "catalog:",
      '  "@effect/vitest": 4.0.0-rc.111',
      '  "@opencode/plugin": 2.0.26',
      "  effect: 4.0.0-rc.112",
      "  vitest: 4.1.11",
      "",
    ].join("\n")

    expect(
      catalogRules.problems(layout.withFile(WORKSPACE, workspace)),
    ).toStrictEqual([
      `${WORKSPACE}: The catalog pins "@effect/vitest" to "4.0.0-rc.111", but @opencode/plugin 2.0.26, the host, depends on effect "4.0.0-rc.112". Set it to "4.0.0-rc.112".`,
    ])
  })
})

describe("the installed host", () => {
  it("is the one the catalog pins", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const host = JSON.stringify({
      dependencies: { effect: "4.0.0-rc.112" },
      version: "2.0.25",
    })

    expect(catalogRules.problems(layout.withFile(HOST, host))).toStrictEqual([
      `${HOST}: The installed @opencode/plugin is "2.0.25", but the catalog pins "2.0.26". Run pnpm install.`,
    ])
  })

  it("is installed", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(catalogRules.problems(layout.withoutFile(HOST))).toStrictEqual([
      `${WORKSPACE}: No plugin has @opencode/plugin installed, so the checks can't read the effect version the host pins. Run pnpm install.`,
    ])
  })
})

describe("an unreadable catalog", () => {
  it("is one problem, on one line", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const problems = catalogRules.problems(
      layout.withFile(WORKSPACE, "catalog: [unclosed"),
    )

    expect(
      problems.map((problem) =>
        problem.startsWith(`${WORKSPACE}: The checks can't read the catalog:`),
      ),
    ).toStrictEqual([true])
    expect(problems.some((problem) => problem.includes("\n"))).toBe(false)
  })

  it("is missing", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(catalogRules.problems(layout.withoutFile(WORKSPACE))).toStrictEqual([
      `${WORKSPACE}: The file is missing. Add it.`,
    ])
  })
})
