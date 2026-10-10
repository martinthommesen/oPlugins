import { Boolean as Bool, Effect, Predicate } from "effect"
import { assert, describe, it } from "@effect/vitest"
import Advisor from "./advisor.ts"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import type { SessionContext } from "@opencode/plugin/effect/session"
import TOOL_NAME from "./tool-name.ts"
import type { Vitest } from "@effect/vitest"
import hooks from "./hooks.ts"
import prompt from "./prompt.ts"
import support from "./advisor.test-support.ts"

/** The tests in a block that provides the advisor around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<Advisor | Scope.Scope>
}

const CONFIGURED = { model: "anthropic/claude-opus-5-5", subagents: false },
  /* The consultation policies a request's system prompt carries. */
  addedPolicies = (event: SessionContext): readonly string[] =>
    event.system
      .map((part) => part.text)
      .filter((text) => text === prompt.CONSULTATION_POLICY),
  advisorTool = { description: prompt.TOOL_DESCRIPTION, input: {} },
  /* Asserts that a request neither offers the advisor nor explains it. */
  assertHidden = (event: SessionContext): void => {
    assert.isFalse(Predicate.hasProperty(event.tools, TOOL_NAME))
    assert.isEmpty(addedPolicies(event))
  },
  /*
   * A request about to be sent for the consulting session, whose agent's
   * tools include the advisor when `offered`.
   */
  eventFor = (offered: boolean): SessionContext => ({
    agent: Agent.ID.make("build"),
    messages: [],
    model: Model.Ref.parse("openai/gpt-6-sol"),
    options: {},
    sessionID: support.SESSION_ID,
    system: [{ text: "You are a coding agent.", type: "text" }],
    tools: Bool.match(offered, {
      onFalse: () => ({}),
      onTrue: () => ({ [TOOL_NAME]: advisorTool }),
    }),
  }),
  /* Runs the hook on a request and returns the request as the hook left it. */
  handled = Effect.fn("presented")(function* presented(
    offered: boolean,
  ): Effect.fn.Return<SessionContext, never, Advisor> {
    const advisor = yield* Advisor,
      event = eventFor(offered)

    yield* hooks.presentAdvisor(advisor)(event)

    return event
  }),
  hidesFromSubagent = Effect.gen(function* hidesFromSubagent() {
    assertHidden(yield* handled(true))
  }),
  hidesWhenCheckFails = Effect.gen(function* hidesWhenCheckFails() {
    assertHidden(yield* handled(true))
  }),
  hidesWhenOff = Effect.gen(function* hidesWhenOff() {
    assertHidden(yield* handled(true))
  }),
  hidesWithoutModel = Effect.gen(function* hidesWithoutModel() {
    assertHidden(yield* handled(true))
  }),
  instructsMainAgent = Effect.gen(function* instructsMainAgent() {
    const event = yield* handled(true)

    assert.isTrue(Predicate.hasProperty(event.tools, TOOL_NAME))
    assert.deepStrictEqual(addedPolicies(event), [prompt.CONSULTATION_POLICY])
  }),
  skipsAgentWithoutTool = Effect.gen(function* skipsAgentWithoutTool() {
    const event = yield* handled(false)

    assert.isEmpty(addedPolicies(event))
  })

describe("presentAdvisor", () => {
  it.layer(support.scriptedServices({}, CONFIGURED))((tests: Tests) => {
    tests.effect("tells a main agent when to consult", () => instructsMainAgent)
  })
  it.layer(support.scriptedServices({ subagent: true }, CONFIGURED))(
    (tests: Tests) => {
      tests.effect(
        "hides the advisor from blocked subagents",
        () => hidesFromSubagent,
      )
    },
  )
  it.layer(support.scriptedServices({}, CONFIGURED))((tests: Tests) => {
    tests.effect(
      "does not instruct agents without the tool",
      () => skipsAgentWithoutTool,
    )
  })
  it.layer(support.scriptedServices({}, {}))((tests: Tests) => {
    tests.effect(
      "hides the advisor when no model is set",
      () => hidesWithoutModel,
    )
  })
  it.layer(
    support.scriptedServices({}, CONFIGURED, [
      ["preferences.enabled", { enabled: false }],
    ]),
  )((tests: Tests) => {
    tests.effect("hides the advisor when it is turned off", () => hidesWhenOff)
  })
  it.layer(
    support.scriptedServices(
      { parentLookup: Effect.fail(support.SERVER_UNAVAILABLE) },
      CONFIGURED,
    ),
  )((tests: Tests) => {
    tests.effect(
      "hides the advisor when the availability check fails",
      () => hidesWhenCheckFails,
    )
  })
})
