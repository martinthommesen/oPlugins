import { Effect, Layer } from "effect"
import {
  NodeCrypto,
  NodeFileSystem,
  NodePath,
} from "@effect/platform-node-shared"
import { expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import FakeKeychain from "#src/fake-keychain.test-support.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import copy from "./headless-credentials.test-support.ts"
import live from "./headless-copy.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Layer.Success<typeof layer> | Scope.Scope>
}

const ONE_REQUEST = 1,
  /** Node's platform, the captured log, and the account to copy. */
  layer = Layer.mergeAll(
    NodeFileSystem.layer,
    NodePath.layer,
    NodeCrypto.layer,
    CapturedLogs.layer,
    FakeKeychain.layer,
    copy.stores,
  ),
  /* Whether the account's own refresh token is in any of `bodies`. */
  spent = (bodies: readonly string[]): boolean =>
    bodies.some((body) => body.includes(copy.ACCOUNT_REFRESH))

test.layer(layer)("live host test copies of an account", (it: Tests) => {
  it.effect("copies the account's access token without its refresh token", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const sandbox = yield* live.copied

      expect(sandbox.store.copied).toBe(true)
      expect(sandbox.text).toContain(copy.account.credentials.accessToken)
      expect(sandbox.text).not.toContain(copy.ACCOUNT_REFRESH)
    }),
  )
})

test.layer(layer)("live host test copies after a 401", (it: Tests) => {
  it.effect("recovers without spending the account's refresh token", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const seen = yield* live.rejectedOnce

      // Recovery reached the token endpoint only with the copy's placeholder.
      expect(seen.sent).toHaveLength(ONE_REQUEST)
      expect(spent(seen.sent)).toBe(false)
      // Nothing rotated, so nothing was written to the sandbox.
      expect(seen.after).toBe(seen.before)
      expect(seen.reply).toContain("authentication_error")
    }),
  )
})

test.layer(layer)("live host test copies the host refreshes", (it: Tests) => {
  it.effect("can't spend the account's refresh token or rotate the copy", () =>
    Effect.gen(function* run() {
      expect.hasAssertions()

      const seen = yield* live.refreshedByHost

      // The host's refresh callback reached the endpoint only with the placeholder.
      expect(seen.sent).toHaveLength(ONE_REQUEST)
      expect(spent(seen.sent)).toBe(false)
      // Nothing rotated, so nothing was written to the sandbox.
      expect(seen.after).toBe(seen.before)
      expect(seen.failed).toBe(true)
    }),
  )
})
