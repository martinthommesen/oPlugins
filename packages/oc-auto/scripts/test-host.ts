/**
 * Runs the shared host test against the packed oc-auto. Set
 * `OC_AUTO_HEADLESS_HOST_VERSION` to test another host version, and
 * `HEADLESS_KEEP` to keep the sandbox afterwards.
 */
import { NodeRuntime } from "@effect/platform-node"
import hostTest from "@oc-lib/host-test/host-test.ts"

NodeRuntime.runMain(
  hostTest.main({
    hostVersionVariable: "OC_AUTO_HEADLESS_HOST_VERSION",
    npmName: "@martinthommesen/oc-auto",
    packageUrl: new URL("..", import.meta.url).href,
    pluginId: "martinthommesen.oc-auto",
  }),
)
