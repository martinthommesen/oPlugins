import {
  COMMAND_DESCRIPTION,
  COMMAND_NAME,
  parseCommand,
  runCommand,
} from "./command.ts"
import { Context, Effect, Layer } from "effect"
import { hideUnavailableAdvisor, instructConsultations } from "./hooks.ts"
import { Advisor } from "./advisor.ts"
import { Host } from "./host.ts"
import { Plugin } from "@opencode/plugin/effect"
import { advisorTool } from "./tool.ts"
import { servicesLayer } from "./services.ts"

export default Plugin.define({
  effect: (context) =>
    Effect.gen(function* advisorPlugin() {
      const built = yield* Layer.build(
        servicesLayer(
          Host.fromPlugin(context),
          context.options,
          context.storage,
        ),
      )

      const advisor = Context.get(built, Advisor)
      const host = Context.get(built, Host)

      yield* context.tool.transform((editor) => {
        editor.add(advisorTool(advisor))
      })

      yield* context.command.transform((editor) => {
        editor.add({
          description: COMMAND_DESCRIPTION,
          execute: ({ prompt, sessionID }) =>
            runCommand(parseCommand(prompt.text)).pipe(
              Effect.flatMap((reply) => host.notify(sessionID, reply)),
              Effect.provide(built),
            ),
          name: COMMAND_NAME,
        })
      })

      yield* context.session.hook("context", hideUnavailableAdvisor(advisor))

      yield* context.session.hook("generate", instructConsultations(host))
    }),
  id: "opencode-advisor",
})
