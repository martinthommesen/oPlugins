import { Context, Effect, Layer } from "effect"
import Advisor from "./advisor.ts"
import Host from "./host.ts"
import { Plugin } from "@opencode/plugin/effect"
import command from "./command.ts"
import hooks from "./hooks.ts"
import services from "./services.ts"
import tool from "./tool.ts"

export default Plugin.define({
  effect: (context) =>
    Effect.gen(function* advisorPlugin() {
      const built = yield* Layer.build(
        services.layer(
          Host.fromPlugin(context),
          context.options,
          context.storage,
        ),
      )

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

      yield* context.session.hook(
        "generate",
        hooks.instructConsultations(Context.get(built, Host)),
      )
    }),
  id: "opencode-advisor",
})
