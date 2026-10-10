import ClaudeCodeStores from "./claude-code-stores.ts"
import CredentialRefresh from "./credential-refresh.ts"
import Environment from "./environment.ts"
import { Layer } from "effect"
import RefreshBackoff from "./refresh-backoff.ts"
import RefreshLock from "./refresh-lock.ts"
import RequestTransforms from "./request-transforms.ts"
import TokenExchange from "./token-exchange.ts"
import nodePlatform from "./node-platform.ts"

/* The environment, over Node's platform services. */
const basics = Environment.layer.pipe(Layer.provideMerge(nodePlatform)),
  /* The stores, coordination, and endpoints a refresh is built from. */
  refreshParts = Layer.mergeAll(
    ClaudeCodeStores.layer,
    RefreshBackoff.layer,
    RefreshLock.layer,
    RequestTransforms.layer,
    TokenExchange.layer,
  ).pipe(Layer.provideMerge(basics)),
  /** Credential refresh and everything under it, over Node, given the plugin's options. */
  refreshing = CredentialRefresh.layer.pipe(Layer.provideMerge(refreshParts))

export default refreshing
