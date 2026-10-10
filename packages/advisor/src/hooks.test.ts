import { Boolean as Bool, Effect, Predicate } from "effect"
import { CONSULTATION_POLICY, TOOL_DESCRIPTION } from "./prompt.ts"
import { SESSION_ID, advisorWith } from "./testing.ts"
import { assert, describe, it } from "@effect/vitest"
import { Agent } from "@opencode/schema/agent"
import type { HostOverrides } from "./testing.ts"
import { Model } from "@opencode/plugin/effect"
import type { PluginOptions } from "@opencode/plugin/options"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { TOOL_NAME } from "./tool-name.ts"
import { presentAdvisor } from "./hooks.ts"

const configured = { model: "anthropic/claude-opus-5-5", subagents: false }

const advisorTool = { description: TOOL_DESCRIPTION, input: {} }

/**
 * A request about to be sent for the consulting session.
 * @param {boolean} offered Whether the agent's tools include the advisor.
 * @returns {SessionContext} The request.
 */
const request = (offered: boolean): SessionContext => ({
  agent: Agent.ID.make("build"),
  messages: [],
  model: Model.Ref.parse("openai/gpt-6-sol"),
  options: {},
  sessionID: SESSION_ID,
  system: [{ text: "You are a coding agent.", type: "text" }],
  tools: Bool.match(offered, {
    onFalse: () => ({}),
    onTrue: () => ({ [TOOL_NAME]: advisorTool }),
  }),
})

/**
 * Runs the hook on a request and returns the request as changed.
 * @param {HostOverrides} script What the host answers with.
 * @param {PluginOptions} options The plugin options.
 * @param {boolean} offered Whether the agent's tools include the advisor.
 * @returns {Effect.Effect<SessionContext>} The changed request.
 */
const presented = Effect.fn("presented")(function* presented(
  script: HostOverrides,
  options: PluginOptions,
  offered: boolean,
): Effect.fn.Return<SessionContext> {
  const [advisor] = yield* advisorWith(script, options)

  const event = request(offered)

  yield* presentAdvisor(advisor)(event)

  return event
})

const policyTexts = (event: SessionContext): readonly string[] =>
  event.system
    .map((part) => part.text)
    .filter((text) => text === CONSULTATION_POLICY)

const instructsMainAgent = Effect.gen(function* instructsMainAgent() {
  const event = yield* presented({}, configured, true)

  assert.isTrue(Predicate.hasProperty(event.tools, TOOL_NAME))
  assert.deepStrictEqual(policyTexts(event), [CONSULTATION_POLICY])
})

const hidesFromSubagent = Effect.gen(function* hidesFromSubagent() {
  const event = yield* presented({ subagent: true }, configured, true)

  assert.isFalse(Predicate.hasProperty(event.tools, TOOL_NAME))
  assert.isEmpty(policyTexts(event))
})

const skipsAgentWithoutTool = Effect.gen(function* skipsAgentWithoutTool() {
  const event = yield* presented({}, configured, false)

  assert.isEmpty(policyTexts(event))
})

const hidesWithoutModel = Effect.gen(function* hidesWithoutModel() {
  const event = yield* presented({}, {}, true)

  assert.isFalse(Predicate.hasProperty(event.tools, TOOL_NAME))
  assert.isEmpty(policyTexts(event))
})

describe(presentAdvisor, () => {
  it.effect("tells a main agent when to consult", () => instructsMainAgent)
  it.effect("hides the advisor from blocked subagents", () => hidesFromSubagent)
  it.effect(
    "does not instruct agents without the tool",
    () => skipsAgentWithoutTool,
  )
  it.effect("hides the advisor when no model is set", () => hidesWithoutModel)
})
