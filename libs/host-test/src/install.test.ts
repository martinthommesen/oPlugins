import { describe, expect, it } from "@effect/vitest"
import install from "./install.ts"

describe("the installed plugin's entry", () => {
  it("lies under the scoped npm name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(install.entrySegments("@martinthommesen/oc-browser")).toStrictEqual([
      "node_modules",
      "@martinthommesen",
      "oc-browser",
      "dist",
      "index.js",
    ])
  })

  it("lies under an unscoped npm name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(install.entrySegments("oc-auth")).toStrictEqual([
      "node_modules",
      "oc-auth",
      "dist",
      "index.js",
    ])
  })
})
