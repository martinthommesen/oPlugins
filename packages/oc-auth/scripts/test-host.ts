/**
 * Manual packed-package smoke test for OpenCode v2, built on the shared
 * host test.
 *
 * Pass --offline to test plugin loading, import, pricing, and a streamed
 * read-tool round trip with a fake credential and a local mock API, without
 * reading real credentials or contacting Anthropic.
 *
 * By default this copies one valid Claude Code account into an isolated source
 * and verifies package loading, automatic import, account labeling, native
 * catalog pricing, and one real read-tool round trip. It never refreshes the
 * copied token because doing so would invalidate its original source.
 *
 * To exercise near-expiry refresh and write-back, set
 * OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR to a disposable Claude config
 * directory. Its refresh token will rotate and the resulting credentials will
 * remain in that directory.
 *
 * Set OC_AUTH_HEADLESS_HOST_VERSION to test another host, and HEADLESS_KEEP
 * to keep the sandbox afterwards.
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
