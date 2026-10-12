import { Effect, Option, Predicate } from "effect"
import { describe, expect, it } from "@effect/vitest"
import consultationAgent from "./consultation-agent.ts"
import hostSupport from "./plugin-host.test-support.ts"
import plugin from "./index.ts"
import prompt from "./prompt.ts"

type RecordingHost = ReturnType<typeof hostSupport.recordingHost>

type StoredAgent = Option.Option.Value<ReturnType<RecordingHost["agent"]>>

/* What the consultation agent relies on, as setup must leave it. */
const REGISTERED = {
    hasModel: false,
    hidden: true,
    mode: "primary",
    permissions: [{ action: "*", effect: "deny", resource: "*" }],
    request: { body: {}, headers: {}, settings: {} },
    system: prompt.ADVISOR_INSTRUCTIONS,
  },
  /* The fields of `agent` the consultation agent relies on. */
  fieldsOf = (
    agent: StoredAgent,
  ): StoredAgent & { readonly hasModel: boolean } => ({
    hasModel: Predicate.hasProperty(agent, "model"),
    hidden: agent.hidden,
    mode: agent.mode,
    permissions: agent.permissions,
    request: agent.request,
    system: agent.system,
  }),
  /* The fields the consultation agent relies on, if setup registered it. */
  registeredFields = (
    recorded: Pick<RecordingHost, "agent">,
  ): Option.Option<ReturnType<typeof fieldsOf>> =>
    recorded
      .agent(consultationAgent.ID)
      .pipe(Option.map((agent) => fieldsOf(agent))),
  /* Sets the plugin up on a recording host, and returns what it recorded. */
  setUp = (taken: boolean): Effect.Effect<RecordingHost> => {
    const recorded = hostSupport.recordingHost(taken)

    return plugin.effect(recorded.host).pipe(Effect.scoped, Effect.as(recorded))
  }

describe("plugin setup's consultation agent", () => {
  it.effect("is registered under its reserved ID", () =>
    Effect.gen(function* registers() {
      expect.hasAssertions()

      const recorded = yield* setUp(false)

      expect(registeredFields(recorded)).toStrictEqual(Option.some(REGISTERED))
      expect(recorded.edits).toStrictEqual([`update ${consultationAgent.ID}`])
    }),
  )

  it.effect("replaces every field it relies on in an existing agent", () =>
    Effect.gen(function* overwrites() {
      expect.hasAssertions()

      const recorded = yield* setUp(true)

      expect(registeredFields(recorded)).toStrictEqual(Option.some(REGISTERED))
    }),
  )

  it.effect("leaves every other agent as it was", () =>
    Effect.gen(function* leavesOthers() {
      expect.hasAssertions()

      const recorded = yield* setUp(true)

      expect(recorded.agent("build")).toStrictEqual(
        Option.some(hostSupport.buildAgent()),
      )
      expect(recorded.edits).toStrictEqual([`update ${consultationAgent.ID}`])
    }),
  )
})

describe("plugin setup's session hooks", () => {
  it.effect("register only the hook that presents the advisor", () =>
    Effect.gen(function* registersHooks() {
      expect.hasAssertions()

      const recorded = yield* setUp(false)

      expect(recorded.hooks).toStrictEqual(["context"])
    }),
  )
})
