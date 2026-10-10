import {
  NodeFileSystem,
  NodePath,
  NodeStdio,
} from "@effect/platform-node-shared"
import { Layer } from "effect"

/**
 * The Node implementations of every platform service the plugin uses:
 * `FileSystem`, `Path`, and `Stdio`.
 */
const nodePlatform = Layer.mergeAll(
  NodeFileSystem.layer,
  NodePath.layer,
  NodeStdio.layer,
)

export default nodePlatform
