import { Effect, Layer } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import type { Scope } from "effect"
import claudeAuth from "./claude-auth-plugin.ts"
import services from "./claude-auth-services.ts"

const FIRST = 0,
  /*
   * Lets OpenCode use Claude Code subscription credentials. The services
   * are built over the decoded options into the plugin's scope. Providing
   * them instead would release them, and their background work, as soon as
   * setup returns. An invalid option (a `PluginOptionsError` naming each
   * problem), a service that fails to build (no home directory, say), or an
   * incompatible host is a defect, which the host reports as a failed
   * plugin.
   *
   * Every import from the host SDK is a type, so the SDK stays out of
   * consumers' installs.
   */
  plugin = {
    effect: (
      context: Parameters<typeof claudeAuth.setUp>[typeof FIRST],
    ): Effect.Effect<void, never, Scope.Scope> => {
      const configured = services.pipe(
        Layer.provideMerge(PluginOptions.layer(context.options)),
      )

      return Layer.build(configured).pipe(
        Effect.orDie,
        Effect.flatMap((built) =>
          claudeAuth.setUp(context).pipe(Effect.provideContext(built)),
        ),
      )
    },
    id: "martinthommesen.oc-auth",
  } satisfies Plugin.Plugin

export default plugin
