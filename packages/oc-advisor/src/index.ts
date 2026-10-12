import { Context, Effect, Layer } from "effect"
import Advisor from "./advisor.ts"
import Host from "./host.ts"
import type { Plugin } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import command from "./command.ts"
import consultationAgent from "./consultation-agent.ts"
import hooks from "./hooks.ts"
import services from "./services.ts"
import tool from "./tool.ts"

type PluginContext = Plugin.Context

/** The parts of the host's plugin context this plugin uses. */
interface PluginHost {
  readonly agent: {
    readonly transform: Parameters<
      typeof consultationAgent.register
    >[typeof FIRST]
  }
  readonly command: Pick<PluginContext["command"], "transform">
  readonly model: Pick<PluginContext["model"], "list">
  readonly options: PluginContext["options"]
  readonly session: Pick<
    PluginContext["session"],
    "context" | "create" | "generate" | "get" | "hook" | "remove" | "synthetic"
  >
  readonly storage: PluginContext["storage"]
  readonly tool: Pick<PluginContext["tool"], "transform">
}

const FIRST = 0,
  /*
   * Registers the consultation agent, the advisor tool, the `/advisor`
   * command, and the session hook.
   */
  install = Effect.fn("AdvisorPlugin.install")(function* install(
    context: PluginHost,
  ) {
    const built = yield* Layer.build(
      services.layer(
        Host.fromPlugin(context),
        context.options,
        context.storage,
      ),
    )

    yield* consultationAgent.register(context.agent.transform)

    yield* context.tool.transform((editor) => {
      editor.add(tool.advisorTool(Context.get(built, Advisor)))
    })

    yield* context.command.transform((editor) => {
      editor.add({
        description: command.COMMAND_DESCRIPTION,
        execute: ({ prompt, sessionID }) =>
          command.runCommand(command.parseCommand(prompt.text)).pipe(
            Effect.flatMap((reply) =>
              Context.get(built, Host).notify(sessionID, reply),
            ),
            Effect.provide(built),
          ),
        name: command.COMMAND_NAME,
      })
    })

    yield* context.session.hook(
      "context",
      hooks.presentAdvisor(Context.get(built, Advisor)),
    )
  }),
  /*
   * Lets agents consult an advisor model. Invalid options are a defect the
   * host reports as a failed plugin.
   */
  plugin = {
    effect: (context: PluginHost): Effect.Effect<void, never, Scope.Scope> =>
      install(context).pipe(Effect.orDie),
    id: "martinthommesen.oc-advisor",
  } satisfies Plugin.Plugin

export default plugin
