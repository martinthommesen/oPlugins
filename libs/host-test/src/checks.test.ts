import { describe, expect, it } from "@effect/vitest"
import checks from "./checks.ts"

describe("the marker file", () => {
  it("lists a plugin the wrapper saw start", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      checks.listsStarted(
        "martinthommesen.oc-auto\nmartinthommesen.oc-browser\n",
        "martinthommesen.oc-browser",
      ),
    ).toBe(true)
  })

  it("does not list a plugin that never started", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(checks.listsStarted("", "martinthommesen.oc-browser")).toBe(false)
  })

  it("does not take a prefix for the plugin's ID", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      checks.listsStarted(
        "martinthommesen.oc-browser.cli\n",
        "martinthommesen.oc-browser",
      ),
    ).toBe(false)
  })
})
