import CredentialRefresh from "./credential-refresh.ts"
import { Layer } from "effect"
import type { Option } from "effect"
import RefreshRig from "./refresh-rig.test-support.ts"
import pluginPlatform from "./plugin-platform.test-support.ts"

type Script = Parameters<typeof RefreshRig.layer>[typeof FIRST]

type Tokens = Option.Option.Value<
  Parameters<typeof RefreshRig.layer>[typeof SECOND]
>

/** Everything a refresh test can reach. */
type Provided =
  | CredentialRefresh
  | Layer.Success<ReturnType<typeof RefreshRig.layer>>
  | Layer.Success<ReturnType<typeof pluginPlatform>>

const FIRST = 0,
  SECOND = 1,
  /*
   * The refresh service over fakes answering per `script`, the store
   * holding `stored`, on the plugin's test platform with default options.
   */
  refreshLayer =
    (script: Script) =>
    (stored: Option.Option<Tokens>): Layer.Layer<Provided> =>
      CredentialRefresh.layer.pipe(
        Layer.provideMerge(RefreshRig.layer(script, stored)),
        Layer.provideMerge(pluginPlatform({})),
      )

export default refreshLayer
