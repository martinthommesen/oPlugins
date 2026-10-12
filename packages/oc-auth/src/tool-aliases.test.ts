import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import toolAliases from "./tool-aliases.ts"

const ONE_ASSERTION = 1,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2

describe("tool alias restoration", () => {
  it.effect("restores only aliases this plugin applied", () =>
    Effect.sync(() => {
      expect.assertions(THREE_ASSERTIONS)

      const aliases = { mcp_Shell: "shell" }

      expect(toolAliases.original("mcp_Shell", aliases)).toBe("shell")
      expect(toolAliases.original("mcp_Playwright_click", aliases)).toBe(
        "mcp_Playwright_click",
      )
      expect(toolAliases.original("constructor", aliases)).toBe("constructor")
    }),
  )
})

describe("tool alias assignment", () => {
  it.effect("prefixes and capitalizes in first-seen order, one-to-one", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)

      const aliases = toolAliases.build(["read_file", "foo", "Foo", "foo"])

      expect(aliases).toStrictEqual([
        ["read_file", "mcp_Read_file"],
        ["foo", "mcp_Foo"],
      ])
      expect(toolAliases.invert(aliases)).toStrictEqual({
        mcp_Foo: "foo",
        mcp_Read_file: "read_file",
      })
    }),
  )

  it.effect("merges alias maps with the later mapping winning", () =>
    Effect.sync(() => {
      expect.assertions(ONE_ASSERTION)
      expect(
        toolAliases.merge(
          { mcp_Foo: "foo", mcp_Read: "read" },
          { mcp_Foo: "Foo", mcp_Shell: "shell" },
        ),
      ).toStrictEqual({ mcp_Foo: "Foo", mcp_Read: "read", mcp_Shell: "shell" })
    }),
  )
})
