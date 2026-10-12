import { Agent, Model } from "@opencode/plugin/effect"
import { Boolean as Bool, Effect, Option } from "effect"
import consultationAgent from "./consultation-agent.ts"
import type plugin from "./index.ts"
import support from "./advisor.test-support.ts"

type PluginHost = Parameters<typeof plugin.effect>[typeof FIRST]

type Transform = Parameters<typeof consultationAgent.register>[typeof FIRST]

type Editor = Parameters<Parameters<Transform>[typeof FIRST]>[typeof FIRST]

type AgentDraft = Parameters<
  Parameters<Editor["update"]>[typeof SECOND]
>[typeof FIRST]

/** The fields of an agent that the tests read. */
interface StoredAgent {
  readonly hidden: boolean
  readonly mode: string
  readonly model?: unknown
  readonly permissions: readonly {
    readonly action: string
    readonly effect: string
    readonly resource: string
  }[]
  readonly request: unknown
  readonly system?: string | undefined
}

/** A host for setup, and what setup registered on it. */
interface RecordingHost {
  /** The host's agent with an ID, as the agent editor left it. */
  readonly agent: (id: string) => Option.Option<StoredAgent>
  /** The agent updates setup made, as `update id`, in order. */
  readonly edits: readonly string[]
  /** The session hooks setup registered, by name, in order. */
  readonly hooks: readonly string[]
  readonly host: PluginHost
}

const FIRST = 0,
  REGISTRATION = { dispose: Effect.void },
  SECOND = 1,
  /* A host call that registers something, as setup's calls do. */
  acceptRegistration = (): Effect.Effect<typeof REGISTRATION> =>
    Effect.succeed(REGISTRATION),
  /* The built-in agent every host has, which setup must leave alone. */
  buildAgent = (): AgentDraft => Agent.Info.default(Agent.ID.make("build")),
  /*
   * A user's agent under the consultation agent's reserved ID, with a value
   * other than the consultation agent's in every field it relies on.
   */
  conflictingAgent = (): AgentDraft => ({
    description: "A user's own agent.",
    hidden: false,
    id: consultationAgent.ID,
    mode: "subagent",
    model: Model.Ref.parse("openai/gpt-6-sol"),
    name: Agent.Name.make("Mine"),
    permissions: [
      { action: "*", effect: "deny", resource: "*" },
      { action: "*", effect: "allow", resource: "*" },
    ],
    request: {
      body: { temperature: 1 },
      headers: { "x-agent": "mine" },
      settings: { timeout: false },
    },
    system: "You are a helpful assistant.",
  }),
  /* A host call setup must not make. */
  dieIfCalled = (): Effect.Effect<never> => Effect.die("setup called the host"),
  /*
   * An agent editor that records each update, over the built-in `build` agent
   * and, when `taken`, a user's agent under the consultation agent's ID. An
   * update of an agent the host lacks starts from the host's default.
   */
  recordingEditor = (
    taken: boolean,
  ): Pick<RecordingHost, "agent" | "edits"> & {
    readonly editor: Editor
  } => {
    const agents = new Map<string, AgentDraft>([
        ["build", buildAgent()],
        ...Bool.match(taken, {
          onFalse: (): [string, AgentDraft][] => [],
          onTrue: (): [string, AgentDraft][] => [
            [consultationAgent.ID, conflictingAgent()],
          ],
        }),
      ]),
      edits: string[] = []

    return {
      agent: (id) => Option.fromUndefinedOr(agents.get(id)),
      editor: {
        update: (id, edit) => {
          const draft = agents.get(id) ?? Agent.Info.default(Agent.ID.make(id))

          edits.push(`update ${id}`)
          edit(draft)
          agents.set(id, draft)
        },
      },
      edits,
    }
  },
  /*
   * A host that records the agent edits and session hooks of setup. When
   * `taken`, a user's agent already has the consultation agent's ID.
   */
  recordingHost = (taken: boolean): RecordingHost => {
    const { agent, editor, edits } = recordingEditor(taken),
      hooks: string[] = []

    return {
      agent,
      edits,
      hooks,
      host: {
        agent: {
          transform: (edit) =>
            Effect.sync(() => {
              edit(editor)
            }).pipe(Effect.as(REGISTRATION)),
        },
        command: { transform: acceptRegistration },
        model: { list: dieIfCalled },
        options: { model: "anthropic/claude-opus-5-5" },
        session: {
          context: dieIfCalled,
          create: dieIfCalled,
          generate: dieIfCalled,
          get: dieIfCalled,
          hook: (name) =>
            Effect.sync(() => {
              hooks.push(name)
            }).pipe(Effect.as(REGISTRATION)),
          remove: dieIfCalled,
          synthetic: dieIfCalled,
        },
        storage: support.memoryStorage(),
        tool: { transform: acceptRegistration },
      },
    }
  }

/** A host that records what plugin setup registers on it. */
export default Object.freeze({ buildAgent, recordingHost })
