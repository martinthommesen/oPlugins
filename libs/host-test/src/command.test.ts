import { describe, expect, it } from "@effect/vitest"
import { Option } from "effect"
import command from "./command.ts"

const FAILURE = 1

describe("a failed command's description", () => {
  it("names the exit code", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(command.describe(Option.some(FAILURE))).toBe("exited 1")
  })

  it(
    "names the timeout of a command that was killed",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(command.describe(Option.none())).toBe(
        "timed out after 180 seconds",
      )
    },
  )
})
