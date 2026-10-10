import type { Config, Option } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import CapturedStderr from "./captured-stderr.test-support.ts"
import CredentialRefresh from "./credential-refresh.ts"
import DebugLog from "./debug-log.ts"
import { Layer } from "effect"
import RefreshBackoff from "./refresh-backoff.ts"
import RefreshRig from "./refresh-rig.test-support.ts"
import testEnvironment from "./test-environment.test-support.ts"

type Script = Parameters<typeof RefreshRig.layer>[typeof FIRST]

type Tokens = Option.Option.Value<
  Parameters<typeof RefreshRig.layer>[typeof SECOND]
>

/** Everything a refresh test can reach. */
type Provided =
  | CredentialRefresh
  | DebugLog
  | Layer.Success<ReturnType<typeof RefreshRig.layer>>
  | Layer.Success<ReturnType<typeof testEnvironment>>
  | Layer.Success<typeof platform>
  | RefreshBackoff

const FIRST = 0,
  SECOND = 1,
  /** Node's crypto, files, and paths, with stderr captured. */
  platform = Layer.mergeAll(
    NodeCrypto.layer,
    NodeFileSystem.layer,
    NodePath.layer,
    CapturedStderr.layer,
  ),
  /*
   * The refresh service over fakes answering per `script`, the store
   * holding `stored`, with the real backoff and debug log on a machine
   * whose home holds nothing.
   */
  refreshLayer = (
    script: Script,
    stored: Option.Option<Tokens>,
  ): Layer.Layer<Provided, Config.ConfigError> =>
    CredentialRefresh.layer.pipe(
      Layer.provideMerge(RefreshRig.layer(script, stored)),
      Layer.provideMerge(RefreshBackoff.layer),
      Layer.provideMerge(DebugLog.layer),
      Layer.provideMerge(testEnvironment({ HOME: "/nonexistent-home" })),
      Layer.provideMerge(platform),
    )

export default refreshLayer
