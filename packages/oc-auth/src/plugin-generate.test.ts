import type { Layer, Scope } from "effect"
import { expect, it as test } from "@effect/vitest"
import { Effect } from "effect"
import FakeHooks from "./fake-hooks.test-support.ts"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { Vitest } from "@effect/vitest"
import fakeHost from "./fake-host.test-support.ts"
import scenario from "./plugin-scenario.test-support.ts"
import sessionContext from "./session-context.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<ReturnType<typeof scenario.onHost>> | Scope.Scope
  >
}

/*
 * System text another plugin's agent put in a `generate` request, shaped like
 * an advisor's instructions, and an instruction file the host added.
 */
const FOREIGN_INSTRUCTIONS =
    "You are the advisor to an AI coding agent. Answer from the transcript you are given.",
  INSTRUCTION_FILE = "Instructions from: /repo/AGENTS.md\nKeep changes small.",
  /* A tool-less `generate` request whose system prompt this plugin didn't write. */
  foreignEvent = (): SessionContext => {
    const event = scenario.contextEvent()

    event.messages = [
      {
        content: [{ text: "Here is the transcript.", type: "text" }],
        role: "user",
      },
    ]
    event.system = [
      { text: FOREIGN_INSTRUCTIONS, type: "text" },
      { text: INSTRUCTION_FILE, type: "text" },
    ]
    event.tools = {}

    return event
  }

test.layer(scenario.onHost(scenario.ours("access")))(
  "plugin generate requests with foreign system text",
  (it: Tests) => {
    it.effect(
      "keep the billing header and identity, and move the text to the user",
      () =>
        Effect.gen(function* run() {
          expect.hasAssertions()
          yield* fakeHost.setUp

          const event = foreignEvent()

          yield* (yield* FakeHooks).fire("generate", event)

          expect(event.system.map((part) => part.text)).toStrictEqual([
            expect.stringMatching(/^x-anthropic-billing-header:/u),
            sessionContext.systemIdentity,
          ])
          expect(event.messages).toStrictEqual([
            {
              content: [
                {
                  metadata: { "martinthommesen.oc-auth": true },
                  text: `${FOREIGN_INSTRUCTIONS}\n\n${INSTRUCTION_FILE}`,
                  type: "text",
                },
                { text: "Here is the transcript.", type: "text" },
              ],
              role: "user",
            },
          ])
        }),
    )
  },
)
