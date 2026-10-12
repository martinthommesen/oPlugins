/**
 * Runs the shared host test on the packed oc-browser plugin. Set
 * `OC_BROWSER_HEADLESS_HOST_VERSION` to test another host version, and
 * `HEADLESS_KEEP` to keep the sandbox afterwards.
 */
import { NodeRuntime } from "@effect/platform-node"
import hostTest from "@oc-lib/host-test/host-test.ts"

NodeRuntime.runMain(
  hostTest.main({
    hostVersionVariable: "OC_BROWSER_HEADLESS_HOST_VERSION",
    npmName: "@martinthommesen/oc-browser",
    packageUrl: new URL("..", import.meta.url).href,
    pluginId: "martinthommesen.oc-browser",
  }),
)
