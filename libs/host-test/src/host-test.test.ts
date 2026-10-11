import { describe, expect, it } from "@effect/vitest"
import hostTest from "./host-test.ts"

describe("the plugin name", () => {
  it("is the npm name without its scope", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(hostTest.bareName("@martinthommesen/oc-browser")).toBe("oc-browser")
  })

  it("is an unscoped npm name as it is", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(hostTest.bareName("oc-auth")).toBe("oc-auth")
  })
})
