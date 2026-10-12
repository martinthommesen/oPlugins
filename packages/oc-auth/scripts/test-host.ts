/**
 * Smoke test of the packed plugin in a headless OpenCode v2 host, built on
 * the shared host test. Each mode says what it reads, refreshes, and writes.
 *
 * With `--offline` (`pnpm run test:host`), it tests plugin loading, import,
 * pricing, and a streamed read-tool round trip with a fake credential and a
 * local mock API. It reads no real credentials and doesn't contact
 * Anthropic.
 *
 * Without it (`pnpm run test:headless`), it reads your Claude Code accounts
 * and copies the first one's access token, without its refresh token, into
 * a credentials file in the sandbox. It checks package loading, automatic
 * import, the account label, native catalog pricing, and one real read-tool
 * round trip. The copy can't refresh, so neither the plugin nor the host can
 * spend the account's refresh token: a run that would need a refresh fails
 * and says why. It writes nothing outside the sandbox.
 *
 * With `OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR` set to a disposable Claude Code
 * config directory, a live run reads only that directory's credentials,
 * makes them expire, and tests near-expiry refresh and write-back: the
 * refresh token rotates at Anthropic, and the new credentials stay in that
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
