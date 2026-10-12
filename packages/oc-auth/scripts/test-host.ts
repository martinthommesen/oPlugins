/**
 * Smoke test of the packed plugin in a headless OpenCode v2 host, built on
 * the shared host test.
 *
 * With `--offline`, it tests plugin loading, import, pricing, and a streamed
 * read-tool round trip with a fake credential and a local mock API. It reads
 * no real credentials and doesn't contact Anthropic.
 *
 * Without it, the test copies one valid Claude Code account into a
 * credentials file in the sandbox. It checks package loading, automatic
 * import, the account label, native catalog pricing, and one real read-tool
 * round trip. It never refreshes the copied token, because a refresh would
 * rotate the token out from under the account's own credential store.
 *
 * To test near-expiry refresh and write-back, set
 * `OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR` to a disposable Claude Code config
 * directory. Its refresh token rotates, and the new credentials stay in that
 * directory.
 *
 * Set `OC_AUTH_HEADLESS_HOST_VERSION` to test another host, and
 * `HEADLESS_KEEP` to keep the sandbox afterwards.
 */
import { Effect, Layer } from "effect"
import { NodeRuntime } from "@effect/platform-node"
import headlessServices from "./headless-services.ts"
import smokeTest from "./headless-smoke-test.ts"

NodeRuntime.runMain(
  Layer.build(headlessServices).pipe(
    Effect.flatMap((services) =>
      smokeTest.pipe(Effect.provideContext(services)),
    ),
    Effect.scoped,
  ),
)
