/**
 * Runs the shared host test, a smoke test of the packed package on OpenCode
 * v2, for oc-advisor. Set `OC_ADVISOR_HEADLESS_HOST_VERSION` to test another
 * host version, and `HEADLESS_KEEP` to keep the sandbox afterwards.
 */
import { NodeRuntime } from "@effect/platform-node"
import hostTest from "@oc-lib/host-test/host-test.ts"

NodeRuntime.runMain(
  hostTest.main({
    hostVersionVariable: "OC_ADVISOR_HEADLESS_HOST_VERSION",
    npmName: "@martinthommesen/oc-advisor",
    packageUrl: new URL("..", import.meta.url).href,
    pluginId: "martinthommesen.oc-advisor",
  }),
)
