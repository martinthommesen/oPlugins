import { Effect, Layer, Option, Schema } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import CapturedLogs from "@oc-lib/captured-logs/captured-logs.ts"
import FakeKeychain from "./fake-keychain.test-support.ts"
import { Hex } from "effect/encoding"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import keychainItems from "./keychain-items.ts"
import sources from "./claude-code-sources.ts"
import support from "./claude-code-stores.test-support.ts"
import testEnvironment from "./test-environment.test-support.ts"

/* What each process failure is reported as. */
const FAILURE_TYPES = [
    ["spawn", "start_failed"],
    ["signal", "no_exit_status"],
    ["output", "output_failed"],
  ] as const,
  FIRST = 0,
  LONG_TOKEN_LENGTH = 6000,
  /** Captured log records, as JSON text. */
  LogText = Schema.fromJsonString(Schema.Unknown),
  /** A token long enough to push any blob holding it onto argv. */
  PADDING = "m".repeat(LONG_TOKEN_LENGTH),
  /** Refreshed tokens, which no record may carry. */
  SECRETS = {
    accessToken: "new-access-secret-4f1d",
    expiresAt: 3000,
    refreshToken: "new-refresh-secret-9c2e",
  },
  /** A blob holding the refreshed tokens, too long for `security -i`. */
  SECRET_BLOB = JSON.stringify({
    claudeAiOauth: SECRETS,
    mcpOAuth: { server: { accessToken: PADDING } },
  }),
  /** The primary item, holding a blob too long for `security -i`. */
  STORED_ITEM = [
    [sources.PRIMARY_SERVICE, SECRET_BLOB.replaceAll("new-", "old-")],
    [`${sources.PRIMARY_SERVICE}.account`, "me@example.com"],
  ] as const,
  /** The stores' services, and the environment `security` runs in. */
  Services = Layer.mergeAll(
    support.layer,
    testEnvironment({ HOME: "/nonexistent-claude-auth-home" })(),
  ),
  /** Write-back tries an unreachable store twice. */
  TWO_ATTEMPTS = 2,
  /** Every value no record may carry, as text and as hex. */
  UNSEEN = [
    SECRETS.accessToken,
    SECRETS.refreshToken,
    PADDING.slice(FIRST, SECRETS.accessToken.length),
    SECRET_BLOB,
  ].flatMap((secret) => [secret, Hex.encode(secret)]),
  /*
   * Write refreshed tokens back over an item whose argv writes end in
   * `failure`, then write a blob through the same path directly. What the
   * write-back returned, the writes it tried, the error the direct write
   * failed with, and every record logged.
   */
  failedWrite = Effect.fn("test.failedWrite")(function* failedWrite(
    failure: string,
  ) {
    const outcome = yield* support.onMac(
        [...STORED_ITEM, [FakeKeychain.processFailureFile, failure]],
        (stores) =>
          stores.writeBack({
            configDir: Option.none(),
            credentials: SECRETS,
            expectedAccessToken: "old-access-secret-4f1d",
            source: sources.PRIMARY_SERVICE,
          }),
      ),
      spawned = (yield* (yield* FakeKeychain).argv).filter(
        (argv) => argv[FIRST] === "add-generic-password",
      ),
      thrown = yield* keychainItems
        .addGenericPassword(
          sources.PRIMARY_SERVICE,
          "me@example.com",
          SECRET_BLOB,
        )
        .pipe(Effect.flip),
      trail = yield* (yield* CapturedLogs).records

    return { outcome, spawned, thrown, trail }
  }),
  /* Which of `UNSEEN` appear in `text`, in any letter case. */
  leaked = (text: string): readonly string[] =>
    UNSEEN.filter((needle) => text.toLowerCase().includes(needle.toLowerCase()))

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Layer.Success<typeof Services> | Scope.Scope>
}

describe("keychain argv writes whose process fails", () => {
  // One block per failure, so each test seeds a Keychain of its own.
  for (const [failure, errorType] of FAILURE_TYPES) {
    test.layer(Services)((it: Tests) => {
      it.effect(`reports ${failure} without the credentials`, () =>
        Effect.gen(function* run() {
          expect.hasAssertions()

          const expected = `security add-generic-password failed (${errorType})`,
            failed = yield* failedWrite(failure),
            text = yield* Schema.encodeEffect(LogText)(failed.trail),
            thrownText = String(failed.thrown)

          expect([failed.outcome, failed.spawned.length]).toStrictEqual([
            "unavailable",
            TWO_ATTEMPTS,
          ])
          expect(
            failed.trail
              .filter((record) => record.message === "writeback_failed")
              .map((record) => record.annotations["error"]),
          ).toStrictEqual([expected, expected])
          expect(failed.thrown.message).toBe(expected)
          expect(leaked(`${text}${thrownText}`)).toStrictEqual([])
        }),
      )
    })
  }
})
