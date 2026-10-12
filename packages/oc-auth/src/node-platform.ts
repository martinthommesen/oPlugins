import {
  NodeChildProcessSpawner,
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import { Layer } from "effect"

/**
 * The Node implementations of every platform service the plugin uses:
 * `FileSystem`, `Path`, `ChildProcessSpawner`, and `Crypto`.
 */
const nodePlatform = Layer.mergeAll(
  NodeChildProcessSpawner.layer,
  NodeCrypto.layer,
).pipe(Layer.provideMerge(Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)))

/** @internal */
export default nodePlatform
