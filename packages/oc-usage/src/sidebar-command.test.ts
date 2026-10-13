import { Effect, Layer } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import sidebarCommand from "./sidebar-command.ts"

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

const { SidebarRequest } = sidebarCommand,
  /** `/show-usage` arguments and the requests they parse to. */
  PARSED = [
    ["on", SidebarRequest.Set({ shown: true })],
    ["  OFF ", SidebarRequest.Set({ shown: false })],
    ["", SidebarRequest.Toggle()],
    ["   ", SidebarRequest.Toggle()],
    [" maybe ", SidebarRequest.Invalid({ input: "maybe" })],
  ] as const

describe("the /show-usage argument", () => {
  for (const [input, expected] of PARSED) {
    test.layer(Layer.empty)((it: PureTests) => {
      it.effect(`parses ${JSON.stringify(input)}`, () =>
        Effect.sync(() => {
          expect.hasAssertions()
          expect(sidebarCommand.parse(input)).toStrictEqual(expected)
        }),
      )
    })
  }
})
