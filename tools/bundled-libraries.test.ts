import { describe, expect, it } from "@effect/vitest"
import bundledLibraries from "./bundled-libraries.ts"
import bundling from "./bundling.test-support.ts"

describe("the libraries bundled into a plugin", () => {
  it("are the ones its code imports, and theirs", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      bundledLibraries.bundledInto(bundling.LAYOUT, "oc-one"),
    ).toStrictEqual(["deep", "shared"])
  })

  it("count re-exports and dynamic imports", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      bundledLibraries.bundledInto(bundling.LAYOUT, "oc-two"),
    ).toStrictEqual(["deep", "lazy", "shared"])
  })

  it("leave out type-only imports and test support", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      bundledLibraries.bundledInto(bundling.LAYOUT, "oc-three"),
    ).toStrictEqual([])
  })
})

describe("what a bundled library is made of", () => {
  it(
    "is its package.json and its code, without tests",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        bundledLibraries
          .inputsOf(bundling.LAYOUT, "shared")
          .map(([file]: readonly [string, string]) => file),
      ).toStrictEqual(["libs/shared/package.json", "libs/shared/src/shared.ts"])
    },
  )
})
