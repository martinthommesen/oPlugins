import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import { Layer } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import PluginOptions from "./plugin-options.ts"
import RefreshBackoff from "./refresh-backoff.ts"
import testEnvironment from "./test-environment.test-support.ts"
import transformsSupport from "./request-transforms.test-support.ts"

/* Node's crypto, files, and paths, with the log captured. */
const platform = Layer.mergeAll(
    CapturedLogs.layer,
    NodeCrypto.layer,
    NodeFileSystem.layer,
    NodePath.layer,
  ),
  /*
   * What the plugin's services stand on in a test: the plugin's `options`,
   * and the real backoff and request transforms, on a machine whose home
   * holds nothing.
   */
  pluginPlatform = (
    options: Plugin.Context["options"],
  ): Layer.Layer<
    | Layer.Success<typeof platform>
    | Layer.Success<ReturnType<typeof transformsSupport.layer>>
    | Layer.Success<ReturnType<ReturnType<typeof testEnvironment>>>
    | PluginOptions
    | RefreshBackoff
  > =>
    Layer.mergeAll(RefreshBackoff.layer, transformsSupport.layer(options)).pipe(
      Layer.provideMerge(PluginOptions.layer(options)),
      Layer.provideMerge(
        testEnvironment({ HOME: "/nonexistent-claude-auth-home" })(),
      ),
      Layer.provideMerge(platform),
      Layer.orDie,
    )

export default pluginPlatform
