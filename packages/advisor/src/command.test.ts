import { AdvisorCommand, parseCommand, runCommand } from "./command.ts"
import { Effect, Layer, pipe } from "effect"
import { assert, describe, expect, it } from "@effect/vitest"
import { fakeHost, memoryStorage } from "./testing.ts"
import { servicesLayer } from "./services.ts"

/**
 * Runs `/advisor` commands in order against fresh services.
 * @param {readonly string[]} inputs The arguments of each invocation.
 * @returns {Effect.Effect<readonly string[]>} The replies.
 */
const replies = (inputs: readonly string[]): Effect.Effect<readonly string[]> =>
  Effect.gen(function* runReplies() {
    const [host] = yield* fakeHost({})

    const services = Layer.fresh(servicesLayer(host, {}, memoryStorage()))

    return yield* pipe(
      inputs,
      Effect.forEach((input) => runCommand(parseCommand(input))),
      Effect.provide(services),
    )
  })

const setsModel = Effect.gen(function* setsModel() {
  const [set, status] = yield* replies(["anthropic/claude-opus-5-5#high", ""])

  assert.strictEqual(set, "Advisor set to anthropic/claude-opus-5-5#high.")
  assert.include(status, "Advisor: anthropic/claude-opus-5-5#high (on)")
  assert.include(status, "Subagents: allowed")
})

const rejectsModels = Effect.gen(function* rejectsModels() {
  const [unknown, variant, malformed, status] = yield* replies([
    "openai/gpt-0",
    "anthropic/claude-opus-5-5#max",
    "opus",
    "",
  ])

  assert.include(unknown, "no available model has that id")
  assert.include(variant, "the model has no such variant")
  assert.include(malformed, "expected provider/model")
  assert.include(status, "Advisor: not set")
})

const togglesAdvisor = Effect.gen(function* togglesAdvisor() {
  const [, off, offStatus, on] = yield* replies([
    "anthropic/claude-opus-5-5",
    "off",
    "",
    "on",
  ])

  assert.strictEqual(off, "Advisor turned off.")
  assert.include(offStatus, "anthropic/claude-opus-5-5 (off)")
  assert.strictEqual(on, "Advisor turned on (anthropic/claude-opus-5-5).")
})

const needsModel = Effect.gen(function* needsModel() {
  const [on] = yield* replies(["on"])

  assert.include(on, "No advisor model is set")
})

const recordsSubagents = Effect.gen(function* recordsSubagents() {
  const [blocked, status] = yield* replies(["subagents off", ""])

  assert.strictEqual(blocked, "Subagents can no longer consult the advisor.")
  assert.include(status, "Subagents: not allowed")
})

describe(parseCommand, () => {
  it.each([
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
  ])("parses %j", { timeout: 5000 }, (input, expected) => {
    expect.hasAssertions()

    expect(parseCommand(input)).toStrictEqual(expected)
  })
})

describe(runCommand, () => {
  it.effect("sets a selectable model and reports it as on", () => setsModel)

  it.effect("rejects models the user cannot select", () => rejectsModels)

  it.effect(
    "turns the advisor off and back on with its model",
    () => togglesAdvisor,
  )

  it.effect("needs a model before it can turn on", () => needsModel)

  it.effect(
    "records whether subagents may consult the advisor",
    () => recordsSubagents,
  )
})
