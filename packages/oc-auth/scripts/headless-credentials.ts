import {
  Array as Arr,
  Clock,
  Effect,
  FileSystem,
  Option,
  Path,
  Schema,
} from "effect"
import ClaudeCodeStores from "#src/claude-code-stores.ts"
import type ClaudeCredentials from "#src/claude-credentials.ts"
import HostTestError from "@oc-lib/host-test/host-test-error.ts"
import blob from "#src/claude-credentials-blob.ts"

/** The credential store a run uses, and what a refresh must change in it. */
interface CredentialStore {
  readonly configDir: string
  readonly initialAccess: string
  /** Whether the run must rotate the token and write it back. */
  readonly refreshExpected: boolean
}

const CREDENTIALS_FILE = ".credentials.json",
  /** Any JSON value, as text. */
  Json = Schema.fromJsonString(Schema.Unknown),
  MINIMUM_VALIDITY_MS = 300_000,
  NEAR_EXPIRY_MS = 1000,
  OFFLINE_ACCESS = "offline-test-access",
  OFFLINE_LIFETIME_MS = 3_600_000,
  OFFLINE_REFRESH = "offline-test-refresh",
  PRIVATE_FILE = 0o600,
  /* Write `raw` as the credentials file of `configDir`. */
  addCredentials = Effect.fn("Headless.addCredentials")(
    function* addCredentials(configDir: string, raw: string) {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path

      yield* fs.makeDirectory(configDir, { recursive: true })
      yield* fs.writeFileString(path.join(configDir, CREDENTIALS_FILE), raw, {
        mode: PRIVATE_FILE,
      })
    },
  ),
  /* Whether `current` shows the refresh the run had to make, if it had to. */
  afterRefresh = (
    store: CredentialStore,
    current: Option.Option<typeof ClaudeCredentials.Type>,
    now: number,
  ): boolean =>
    !store.refreshExpected ||
    Option.exists(
      current,
      (credentials) =>
        credentials.accessToken !== store.initialAccess &&
        credentials.expiresAt >= now + MINIMUM_VALIDITY_MS,
    ),
  /* Fail unless an expected near-expiry refresh rotated and wrote back. */
  checkWriteBack = Effect.fn("Headless.checkWriteBack")(
    function* checkWriteBack(store: CredentialStore) {
      const fs = yield* FileSystem.FileSystem,
        now = yield* Clock.currentTimeMillis,
        path = yield* Path.Path,
        stored = yield* fs.readFileString(
          path.join(store.configDir, CREDENTIALS_FILE),
        ),
        tokens = yield* blob.parseCredentials(stored),
        written = afterRefresh(store, tokens, now)

      yield* Effect.fail(
        HostTestError.make({
          message:
            "Near-expiry refresh did not rotate and write back credentials",
        }),
      ).pipe(Effect.when(Effect.succeed(!written)))
    },
  ),
  /*
   * A copy of the first Claude Code account in a credentials file in the
   * sandbox. Its token is never refreshed, because a refresh would rotate
   * the token out from under the account's own credential store.
   */
  copiedStore = Effect.fn("Headless.copiedStore")(function* copiedStore(
    root: string,
  ) {
    const accounts = yield* (yield* ClaudeCodeStores).readAccounts,
      first = Arr.head(accounts),
      now = yield* Clock.currentTimeMillis,
      path = yield* Path.Path,
      target = path.join(root, "claude")

    if (Option.isNone(first)) {
      return yield* HostTestError.make({
        message:
          "No Claude Code credentials found. Run `claude` before this smoke test.",
      })
    }

    if (first.value.credentials.expiresAt < now + MINIMUM_VALIDITY_MS) {
      return yield* HostTestError.make({
        message:
          "Claude Code credentials expire within five minutes. Run `claude`, then run this smoke test again.",
      })
    }

    yield* addCredentials(
      target,
      yield* Schema.encodeEffect(Json)({
        claudeAiOauth: first.value.credentials,
      }),
    )

    return {
      configDir: target,
      initialAccess: first.value.credentials.accessToken,
      refreshExpected: false,
    }
  }),
  /*
   * The disposable config directory, its credentials set to expire in a
   * second so the run refreshes them and writes them back there.
   */
  disposableStore = Effect.fn("Headless.disposableStore")(
    function* disposableStore(configDir: string) {
      const fs = yield* FileSystem.FileSystem,
        now = yield* Clock.currentTimeMillis,
        path = yield* Path.Path,
        store = path.join(configDir, CREDENTIALS_FILE),
        text = yield* fs.readFileString(store),
        tokens = yield* blob.parseCredentials(text),
        updated = tokens.pipe(
          Option.flatMap((credentials) =>
            blob.updateCredentialBlob(text, {
              accessToken: credentials.accessToken,
              expiresAt: now + NEAR_EXPIRY_MS,
              refreshToken: credentials.refreshToken,
            }),
          ),
        )

      if (Option.isNone(tokens)) {
        return yield* HostTestError.make({
          message: `Invalid disposable credentials at ${store}`,
        })
      }

      if (Option.isNone(updated)) {
        return yield* HostTestError.make({
          message: `Could not update disposable credentials at ${store}`,
        })
      }

      yield* addCredentials(configDir, updated.value)

      return {
        configDir,
        initialAccess: tokens.value.accessToken,
        refreshExpected: true,
      }
    },
  ),
  /* A fake credential for the mock API; nothing real is read. */
  offlineStore = Effect.fn("Headless.offlineStore")(function* offlineStore(
    root: string,
  ) {
    const now = yield* Clock.currentTimeMillis,
      path = yield* Path.Path,
      target = path.join(root, "claude")

    yield* addCredentials(
      target,
      yield* Schema.encodeEffect(Json)({
        claudeAiOauth: {
          accessToken: OFFLINE_ACCESS,
          expiresAt: now + OFFLINE_LIFETIME_MS,
          refreshToken: OFFLINE_REFRESH,
        },
      }),
    )

    return {
      configDir: target,
      initialAccess: OFFLINE_ACCESS,
      refreshExpected: false,
    }
  }),
  /*
   * The credential store for this run: a fake one offline, the disposable
   * directory `OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR` names, or a copy of a
   * real account.
   */
  prepare = Effect.fn("Headless.prepareCredentials")(function* prepare(
    root: string,
    mode: {
      readonly offline: boolean
      readonly refreshConfigDir: Option.Option<string>
    },
  ) {
    if (mode.offline) {
      return yield* offlineStore(root)
    }

    return yield* Option.match(mode.refreshConfigDir, {
      onNone: () => copiedStore(root),
      onSome: (configDir) => disposableStore(configDir),
    })
  })

/** The credentials the smoke test hands the plugin, and the write-back check. */
export default Object.freeze({ checkWriteBack, prepare })
