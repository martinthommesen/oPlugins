import { Effect, Fiber, Option, Ref } from "effect"
import { SESSION_ID, advisorWith } from "./testing.ts"
import { assert, describe, it } from "@effect/vitest"
import { AdvisorUnavailable } from "./errors/advisor-unavailable.ts"
import { Availability } from "./availability.ts"
import { ConsultationTimedOut } from "./errors/consultation-timed-out.ts"
import { ConversationItem } from "./conversation.ts"
import { TestClock } from "effect/testing"

const TIMEOUT_SECONDS = 30

const configured = { model: "anthropic/claude-opus-5-5" }

const sendsConversation = Effect.gen(function* sendsConversation() {
  const [advisor, prompts] = yield* advisorWith(
    {
      transcript: [ConversationItem.UserMessage({ text: "Add a login form." })],
    },
    configured,
  )

  const advice = yield* advisor.consult(
    SESSION_ID,
    Option.some("Should I hash with SHA-256?"),
  )

  const [prompt] = yield* Ref.get(prompts)

  assert.deepStrictEqual(advice, {
    model: "anthropic/claude-opus-5-5",
    text: "Use a dedicated password hash.",
  })
  assert.include(prompt, "[1] user: Add a login form.")
  assert.include(prompt, "Should I hash with SHA-256?")
})

const refusesWithoutModel = Effect.gen(function* refusesWithoutModel() {
  const [advisor, prompts] = yield* advisorWith({}, {})

  const error = yield* Effect.flip(advisor.consult(SESSION_ID, Option.none()))

  assert.instanceOf(error, AdvisorUnavailable)
  assert.strictEqual(error.reason, "no advisor model is configured")
  assert.deepStrictEqual(yield* Ref.get(prompts), [])
})

const refusesSubagents = Effect.gen(function* refusesSubagents() {
  const [advisor] = yield* advisorWith(
    { subagent: true },
    { model: configured.model, subagents: false },
  )

  const error = yield* Effect.flip(advisor.consult(SESSION_ID, Option.none()))

  assert.instanceOf(error, AdvisorUnavailable)
  assert.strictEqual(error.reason, "the advisor is turned off for subagents")
})

const timesOut = Effect.gen(function* timesOut() {
  const [advisor] = yield* advisorWith(
    { reply: Effect.never },
    { model: configured.model, timeout: TIMEOUT_SECONDS },
  )

  const consultation = Effect.flip(advisor.consult(SESSION_ID, Option.none()))

  const fiber = yield* Effect.forkChild(consultation)

  yield* TestClock.adjust(`${TIMEOUT_SECONDS} seconds`)

  const error = yield* Fiber.join(fiber)

  assert.instanceOf(error, ConsultationTimedOut)
  assert.strictEqual(error.seconds, TIMEOUT_SECONDS)
})

const allowsSubagents = Effect.gen(function* allowsSubagents() {
  const [advisor] = yield* advisorWith({ subagent: true }, configured)

  const availability = yield* advisor.availability(SESSION_ID)

  assert.isTrue(Availability.$is("Available")(availability))
})

describe("advisor.consult", () => {
  it.effect(
    "sends the conversation and question to the advisor model",
    () => sendsConversation,
  )

  it.effect("refuses when no model is configured", () => refusesWithoutModel)

  it.effect(
    "refuses subagents when they are not allowed",
    () => refusesSubagents,
  )

  it.effect(
    "gives up when the advisor model outlasts the timeout",
    () => timesOut,
  )
})

describe("advisor.availability", () => {
  it.effect(
    "lets subagents consult the advisor by default",
    () => allowsSubagents,
  )
})
