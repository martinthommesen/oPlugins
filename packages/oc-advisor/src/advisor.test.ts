import { Effect, Fiber, Option, Ref } from "effect"
import { assert, describe, it as test } from "@effect/vitest"
import Advisor from "./advisor.ts"
import AdvisorUnavailable from "./advisor-unavailable-error.ts"
import ConsultationTimedOut from "./consultation-timed-out-error.ts"
import FakeHost from "./fake-host.test-support.ts"
import type { Scope } from "effect"
import { TestClock } from "effect/testing"
import type { Vitest } from "@effect/vitest"
import availability from "./availability.ts"
import conversation from "./conversation.ts"
import support from "./advisor.test-support.ts"

/** The tests in a block that provides the advisor around a scripted host. */
interface Tests {
  readonly effect: Vitest.Test<Advisor | FakeHost | Scope.Scope>
}

const { ConversationItem } = conversation,
  TIMEOUT_SECONDS = 30,
  allowsSubagents = Effect.gen(function* allowsSubagents() {
    const advisor = yield* Advisor,
      decision = yield* advisor.availability(support.SESSION_ID)

    assert.isTrue(availability.Availability.$is("Available")(decision))
  }),
  configured = { model: "anthropic/claude-opus-5-5" },
  refusesSubagents = Effect.gen(function* refusesSubagents() {
    const advisor = yield* Advisor,
      error = yield* Effect.flip(
        advisor.consult(support.SESSION_ID, Option.none()),
      )

    assert.instanceOf(error, AdvisorUnavailable)
    assert.strictEqual(error.reason, "the advisor is turned off for subagents")
  }),
  refusesWithoutModel = Effect.gen(function* refusesWithoutModel() {
    const advisor = yield* Advisor,
      error = yield* Effect.flip(
        advisor.consult(support.SESSION_ID, Option.none()),
      ),
      record = yield* FakeHost

    assert.instanceOf(error, AdvisorUnavailable)
    assert.strictEqual(error.reason, "no advisor model is configured")
    assert.deepStrictEqual(yield* Ref.get(record.prompts), [])
  }),
  sendsConversation = Effect.gen(function* sendsConversation() {
    const advisor = yield* Advisor,
      record = yield* FakeHost,
      reply = yield* advisor.consult(
        support.SESSION_ID,
        Option.some("Should I hash with SHA-256?"),
      ),
      [prompt] = yield* Ref.get(record.prompts)

    assert.deepStrictEqual(reply, {
      model: "anthropic/claude-opus-5-5",
      text: "Use a dedicated password hash.",
    })
    assert.include(prompt, "[1] user: Add a login form.")
    assert.include(prompt, "Should I hash with SHA-256?")
  }),
  timesOut = Effect.gen(function* timesOut() {
    const advisor = yield* Advisor,
      fiber = yield* advisor
        .consult(support.SESSION_ID, Option.none())
        .pipe(Effect.flip, Effect.forkChild),
      timedOut = yield* TestClock.adjust(`${TIMEOUT_SECONDS} seconds`).pipe(
        Effect.andThen(Fiber.join(fiber)),
      )

    assert.instanceOf(timedOut, ConsultationTimedOut)
    assert.strictEqual(timedOut.seconds, TIMEOUT_SECONDS)
  })

describe("advisor.consult", () => {
  test.layer(
    support.scriptedServices(
      {
        transcript: [
          ConversationItem.UserMessage({
            text: "Add a login form.",
          }),
        ],
      },
      configured,
    ),
  )((it: Tests) => {
    it.effect(
      "sends the conversation and question to the advisor model",
      () => sendsConversation,
    )
  })

  test.layer(support.scriptedServices({}, {}))((it: Tests) => {
    it.effect("refuses when no model is configured", () => refusesWithoutModel)
  })

  test.layer(
    support.scriptedServices(
      { subagent: true },
      { model: configured.model, subagents: false },
    ),
  )((it: Tests) => {
    it.effect(
      "refuses subagents when they are not allowed",
      () => refusesSubagents,
    )
  })

  test.layer(
    support.scriptedServices(
      { reply: Effect.never },
      { model: configured.model, timeout: TIMEOUT_SECONDS },
    ),
  )((it: Tests) => {
    it.effect(
      "gives up when the advisor model outlasts the timeout",
      () => timesOut,
    )
  })
})

describe("advisor.availability", () => {
  test.layer(support.scriptedServices({ subagent: true }, configured))(
    (it: Tests) => {
      it.effect(
        "lets subagents consult the advisor by default",
        () => allowsSubagents,
      )
    },
  )
})
