import { Effect, Layer } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import ocBrowser from "./oc-browser-plugin.ts"
import services from "./oc-browser-services.ts"

const FIRST = 0,
  /*
   * Lets OpenCode drive the user's browser. The services are built into the
   * plugin's scope rather than provided, because providing would release
   * them, and the work they run in the background, as soon as set-up
   * returns. A failure to build them (no home directory, say) is a defect
   * the host reports as a failed plugin.
   *
   * Every import from the host SDK is a type, so the SDK stays out of
   * consumers' installs.
   */
  plugin = {
    effect: (
      context: Parameters<typeof ocBrowser.setUp>[typeof FIRST],
    ): Effect.Effect<void, never, Scope.Scope> =>
      Layer.build(services).pipe(
        Effect.orDie,
        Effect.flatMap((built) =>
          ocBrowser.setUp(context).pipe(Effect.provideContext(built)),
        ),
      ),
    id: "martinthommesen.oc-browser",
  } satisfies Plugin.Plugin

export default plugin
