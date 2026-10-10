import type { Config, Option } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import CapturedLogs from "./captured-logs.test-support.ts"
import CredentialRefresh from "./credential-refresh.ts"
import { Layer } from "effect"
import PluginOptions from "./plugin-options.ts"
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
  | Layer.Success<ReturnType<typeof RefreshRig.layer>>
  | Layer.Success<ReturnType<ReturnType<typeof testEnvironment>>>
  | Layer.Success<typeof platform>
  | PluginOptions
  | RefreshBackoff

const FIRST = 0,
  SECOND = 1,
  /** Node's crypto, files, and paths, with the log captured. */
  platform = Layer.mergeAll(
    NodeCrypto.layer,
    NodeFileSystem.layer,
    NodePath.layer,
    CapturedLogs.layer,
  ),
  /*
   * The refresh service over fakes answering per `script`, the store
   * holding `stored`, with the real backoff and default options on a
   * machine whose home holds nothing.
   */
  refreshLayer =
    (script: Script) =>
    (
      stored: Option.Option<Tokens>,
    ): Layer.Layer<Provided, Config.ConfigError> =>
      CredentialRefresh.layer.pipe(
        Layer.provideMerge(RefreshRig.layer(script, stored)),
        Layer.provideMerge(RefreshBackoff.layer),
        Layer.provideMerge(PluginOptions.layer({}).pipe(Layer.orDie)),
        Layer.provideMerge(testEnvironment({ HOME: "/nonexistent-home" })()),
        Layer.provideMerge(platform),
      )

export default refreshLayer
