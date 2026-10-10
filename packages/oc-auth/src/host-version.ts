/**
 * The OpenCode host build this release targets. The plugin's compatibility
 * error, the smoke test's CLI install, and its version check all read it, so
 * bumping the host is one edit here plus `package.json`.
 */
const HOST_VERSION = "2.0.26"

export default HOST_VERSION
