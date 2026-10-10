import { Effect } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type { Scope } from "effect"
import ocBrowser from "./oc-browser-plugin.ts"

const FIRST = 0,
  /*
   * Lets OpenCode drive the user's browser. Invalid options are a defect
   * the host reports as a failed plugin, and its log records go to the
   * host's log.
   *
   * Every import from the host SDK is a type, so the SDK stays out of
   * consumers' installs.
   */
  plugin = {
    effect: (
      context: Parameters<typeof ocBrowser.setUp>[typeof FIRST],
    ): Effect.Effect<void, never, Scope.Scope> =>
      ocBrowser.setUp(context).pipe(Effect.orDie),
    id: "martinthommesen.oc-browser",
  } satisfies Plugin.Plugin

export default plugin
