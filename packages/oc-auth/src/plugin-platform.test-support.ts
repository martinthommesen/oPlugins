import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import CapturedStderr from "./captured-stderr.test-support.ts"
import DebugLog from "./debug-log.ts"
import { Layer } from "effect"
import RefreshBackoff from "./refresh-backoff.ts"
import testEnvironment from "./test-environment.test-support.ts"
import transformsSupport from "./request-transforms.test-support.ts"

/* Node's crypto, files, and paths, with stderr captured. */
const platform = Layer.mergeAll(
    CapturedStderr.layer,
    NodeCrypto.layer,
    NodeFileSystem.layer,
    NodePath.layer,
  ),
  /*
   * What the plugin's services stand on in a test: the real debug log,
   * backoff, and request transforms, on a machine whose home holds nothing.
   */
  pluginPlatform = Layer.mergeAll(
    RefreshBackoff.layer,
    transformsSupport.layer(),
  ).pipe(
    Layer.provideMerge(DebugLog.layer),
    Layer.provideMerge(
      testEnvironment({ HOME: "/nonexistent-claude-auth-home" }),
    ),
    Layer.provideMerge(platform),
    Layer.orDie,
  )

export default pluginPlatform
