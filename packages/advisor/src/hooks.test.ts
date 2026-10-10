import { Boolean as Bool, Effect, Predicate } from "effect"
import { CONSULTATION_POLICY, TOOL_DESCRIPTION } from "./prompt.ts"
import {
  SERVER_UNAVAILABLE,
  SESSION_ID,
  advisorWith,
  memoryStorage,
} from "./testing.ts"
import { assert, describe, it } from "@effect/vitest"
import type { Advisor } from "./advisor.ts"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/plugin/effect"
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
 * @param {Advisor["Service"]} advisor The advisor service.
 * @param {boolean} offered Whether the agent's tools include the advisor.
 * @returns {Effect.Effect<SessionContext>} The changed request.
 */
const presented = Effect.fn("presented")(function* presented(
  advisor: Advisor["Service"],
  offered: boolean,
): Effect.fn.Return<SessionContext> {
  const event = request(offered)

  yield* presentAdvisor(advisor)(event)

  return event
})

const policyTexts = (event: SessionContext): readonly string[] =>
  event.system
    .map((part) => part.text)
    .filter((text) => text === CONSULTATION_POLICY)

/**
 * Asserts that a request neither offers the advisor nor explains it.
 * @param {SessionContext} event The request after the hook ran.
 */
const assertHidden = (event: SessionContext): void => {
  assert.isFalse(Predicate.hasProperty(event.tools, TOOL_NAME))
  assert.isEmpty(policyTexts(event))
}

const instructsMainAgent = Effect.gen(function* instructsMainAgent() {
  const [advisor] = yield* advisorWith({}, configured)

  const event = yield* presented(advisor, true)

  assert.isTrue(Predicate.hasProperty(event.tools, TOOL_NAME))
  assert.deepStrictEqual(policyTexts(event), [CONSULTATION_POLICY])
})

const hidesFromSubagent = Effect.gen(function* hidesFromSubagent() {
  const [advisor] = yield* advisorWith({ subagent: true }, configured)

  assertHidden(yield* presented(advisor, true))
})

const skipsAgentWithoutTool = Effect.gen(function* skipsAgentWithoutTool() {
  const [advisor] = yield* advisorWith({}, configured)

  const event = yield* presented(advisor, false)

  assert.isEmpty(policyTexts(event))
})

const hidesWithoutModel = Effect.gen(function* hidesWithoutModel() {
  const [advisor] = yield* advisorWith({}, {})

  assertHidden(yield* presented(advisor, true))
})

const hidesWhenOff = Effect.gen(function* hidesWhenOff() {
  const storage = memoryStorage()

  yield* storage.set("preferences.enabled", { enabled: false })

  const [advisor] = yield* advisorWith({}, configured, storage)

  assertHidden(yield* presented(advisor, true))
})

const hidesWhenCheckFails = Effect.gen(function* hidesWhenCheckFails() {
  const parentLookup = Effect.fail(SERVER_UNAVAILABLE)

  const [advisor] = yield* advisorWith({ parentLookup }, configured)

  assertHidden(yield* presented(advisor, true))
})

describe(presentAdvisor, () => {
  it.effect("tells a main agent when to consult", () => instructsMainAgent)
  it.effect("hides the advisor from blocked subagents", () => hidesFromSubagent)
  it.effect(
    "does not instruct agents without the tool",
    () => skipsAgentWithoutTool,
  )
  it.effect("hides the advisor when no model is set", () => hidesWithoutModel)
  it.effect("hides the advisor when it is turned off", () => hidesWhenOff)
  it.effect(
    "hides the advisor when the availability check fails",
    () => hidesWhenCheckFails,
  )
})
