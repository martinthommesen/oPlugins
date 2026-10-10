import { Effect, Layer } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import type { Scope } from "effect"
import claudeAuth from "./claude-auth-plugin.ts"
import services from "./claude-auth-services.ts"

const FIRST = 0,
  /*
   * Lets OpenCode use Claude Code subscription credentials. The plugin's
   * options are decoded first, and the services are built over them into
   * the plugin's scope rather than provided, because providing would
   * release them, and the work they run in the background, as soon as
   * set-up returns. An invalid option (a `PluginOptionsError` naming each
   * problem), a failure to build the services (no home directory, say), or
   * an incompatible host is a defect the host reports as a failed plugin.
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
