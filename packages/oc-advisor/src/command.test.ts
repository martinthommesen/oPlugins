import { Effect, Layer, pipe } from "effect"
import { assert, describe, expect, it as test } from "@effect/vitest"
import type Host from "./host.ts"
import type PreferenceStore from "./preference-store.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import command from "./command.ts"
import support from "./advisor.test-support.ts"

/** The tests in a block that provides fresh services around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<Host | PreferenceStore | Scope.Scope>
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

const { AdvisorCommand } = command,
  /** `/advisor` inputs and the commands they parse to. */
  PARSED = [
    ["", AdvisorCommand.Status()],
    ["  status ", AdvisorCommand.Status()],
    ["ON", AdvisorCommand.SetEnabled({ enabled: true })],
    ["off", AdvisorCommand.SetEnabled({ enabled: false })],
    ["subagents  off", AdvisorCommand.SetSubagents({ allowed: false })],
    ["Subagents On", AdvisorCommand.SetSubagents({ allowed: true })],
    [
      "anthropic/Claude-Opus#high",
      AdvisorCommand.SetModel({ model: "anthropic/Claude-Opus#high" }),
    ],
    ["two words", AdvisorCommand.Invalid({ input: "two words" })],
    ["subagents maybe", AdvisorCommand.Invalid({ input: "subagents maybe" })],
  ] as const,
  /* Runs `/advisor` commands in order and returns the replies. */
  answers = (
    inputs: readonly string[],
  ): Effect.Effect<readonly string[], never, Host | PreferenceStore> =>
    pipe(
      inputs,
      Effect.forEach((input) =>
        command.runCommand(command.parseCommand(input)),
      ),
    ),
  needsModel = Effect.gen(function* needsModel() {
    const [on] = yield* answers(["on"])

    assert.include(on, "No advisor model is set")
  }),
  recordsSubagents = Effect.gen(function* recordsSubagents() {
    const [blocked, status] = yield* answers(["subagents off", ""])

    assert.strictEqual(blocked, "Subagents can no longer consult the advisor.")
    assert.include(status, "Subagents: not allowed")
  }),
  rejectsModels = Effect.gen(function* rejectsModels() {
    const [unknown, variant, malformed, status] = yield* answers([
      "openai/gpt-0",
      "anthropic/claude-opus-5-5#max",
      "opus",
      "",
    ])

    assert.include(unknown, "no available model has that id")
    assert.include(variant, "the model has no such variant")
    assert.include(malformed, "expected provider/model")
    assert.include(status, "Advisor: not set")
  }),
  setsModel = Effect.gen(function* setsModel() {
    const [set, status] = yield* answers(["anthropic/claude-opus-5-5#high", ""])

    assert.strictEqual(set, "Advisor set to anthropic/claude-opus-5-5#high.")
    assert.include(status, "Advisor: anthropic/claude-opus-5-5#high (on)")
    assert.include(status, "Subagents: allowed")
  }),
  togglesAdvisor = Effect.gen(function* togglesAdvisor() {
    const [, off, offStatus, on] = yield* answers([
      "anthropic/claude-opus-5-5",
      "off",
      "",
      "on",
    ])

    assert.strictEqual(off, "Advisor turned off.")
    assert.include(offStatus, "anthropic/claude-opus-5-5 (off)")
    assert.strictEqual(on, "Advisor turned on (anthropic/claude-opus-5-5).")
  })

describe("parseCommand", () => {
  for (const [input, expected] of PARSED) {
    test.layer(Layer.empty)((it: PureTests) => {
      it.effect(`parses ${JSON.stringify(input)}`, () =>
        Effect.sync(() => {
          expect.hasAssertions()

          expect(command.parseCommand(input)).toStrictEqual(expected)
        }),
      )
    })
  }
})

describe("runCommand", () => {
  test.layer(support.scriptedServices({}, {}))((it: Tests) => {
    it.effect("sets a selectable model and reports it as on", () => setsModel)
  })

  test.layer(support.scriptedServices({}, {}))((it: Tests) => {
    it.effect("rejects models the user cannot select", () => rejectsModels)
  })

  test.layer(support.scriptedServices({}, {}))((it: Tests) => {
    it.effect(
      "turns the advisor off and back on with its model",
      () => togglesAdvisor,
    )
  })

  test.layer(support.scriptedServices({}, {}))((it: Tests) => {
    it.effect("needs a model before it can turn on", () => needsModel)
  })

  test.layer(support.scriptedServices({}, {}))((it: Tests) => {
    it.effect(
      "records whether subagents may consult the advisor",
      () => recordsSubagents,
    )
  })
})
