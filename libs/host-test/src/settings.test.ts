import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import settings from "./settings.ts"

describe("the requested host version", () => {
  it("asks for the targeted host when unset", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(settings.asRequested(Option.none())).toStrictEqual(settings.target())
  })

  it("asks for the targeted host for `target`", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(settings.asRequested(Option.some("target"))).toStrictEqual(
      settings.target(),
    )
  })

  it(
    "asks for the oldest supported host for `oldest`",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(settings.asRequested(Option.some("oldest"))).toStrictEqual(
        settings.oldest(),
      )
    },
  )

  it("asks for any other version as given", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(settings.asRequested(Option.some("2.0.25"))).toStrictEqual(
      settings.exact({ version: "2.0.25" }),
    )
  })
})

describe("the oldest supported host version", () => {
  it("is the version `engines.opencode` starts at", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(settings.oldestOf(">=2.0.25")).toStrictEqual(Option.some("2.0.25"))
  })

  it("is unknown for a range of any other form", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(Option.isNone(settings.oldestOf("^2.0.25"))).toBe(true)
  })
})
