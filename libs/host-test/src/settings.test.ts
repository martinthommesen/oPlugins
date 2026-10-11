import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import settings from "./settings.ts"

describe("the requested host version", () => {
  it("asks for the targeted host when unset", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const requested = settings.asRequested(Option.none())
    expect(Option.isNone(requested)).toBe(true)
  })

  it("asks for the targeted host for `target`", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const requested = settings.asRequested(Option.some("target"))
    expect(Option.isNone(requested)).toBe(true)
  })

  it("asks for any other version as given", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(settings.asRequested(Option.some("2.0.25"))).toStrictEqual(
      Option.some("2.0.25"),
    )
  })
})
