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
import HeadlessSmokeError from "./headless-smoke-error.ts"
import blob from "#src/claude-credentials-blob.ts"

/** Where the plugin finds its credentials, and what a refresh must change. */
interface CredentialSource {
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
    source: CredentialSource,
    current: Option.Option<typeof ClaudeCredentials.Type>,
    now: number,
  ): boolean =>
    !source.refreshExpected ||
    Option.exists(
      current,
      (credentials) =>
        credentials.accessToken !== source.initialAccess &&
        credentials.expiresAt >= now + MINIMUM_VALIDITY_MS,
    ),
  /* Fail unless an expected near-expiry refresh rotated and wrote back. */
  checkWriteBack = Effect.fn("Headless.checkWriteBack")(
    function* checkWriteBack(source: CredentialSource) {
      const fs = yield* FileSystem.FileSystem,
        now = yield* Clock.currentTimeMillis,
        path = yield* Path.Path,
        stored = yield* fs.readFileString(
          path.join(source.configDir, CREDENTIALS_FILE),
        ),
        tokens = yield* blob.parseCredentials(stored),
        written = afterRefresh(source, tokens, now)

      yield* Effect.fail(
        new HeadlessSmokeError({
          message:
            "Near-expiry refresh did not rotate and write back credentials",
        }),
      ).pipe(Effect.when(Effect.succeed(!written)))
    },
  ),
  /*
   * A copy of the first Claude Code account in the sandbox. Its token is
   * never refreshed: that would invalidate its original source.
   */
  copiedSource = Effect.fn("Headless.copiedSource")(function* copiedSource(
    root: string,
  ) {
    const accounts = yield* (yield* ClaudeCodeStores).readAccounts,
      now = yield* Clock.currentTimeMillis,
      path = yield* Path.Path,
      source = Arr.head(accounts),
      target = path.join(root, "claude")

    if (Option.isNone(source)) {
      return yield* new HeadlessSmokeError({
        message:
          "No Claude Code credentials found. Run `claude` before this smoke test.",
      })
    }

    if (source.value.credentials.expiresAt < now + MINIMUM_VALIDITY_MS) {
      return yield* new HeadlessSmokeError({
        message:
          "Claude credentials expire within five minutes. Run `claude` first.",
      })
    }

    yield* addCredentials(
      target,
      yield* Schema.encodeEffect(Json)({
        claudeAiOauth: source.value.credentials,
      }),
    )

    return {
      configDir: target,
      initialAccess: source.value.credentials.accessToken,
      refreshExpected: false,
    }
  }),
  /*
   * The disposable config directory, its credentials set to expire in a
   * second so the run refreshes them and writes them back there.
   */
  disposableSource = Effect.fn("Headless.disposableSource")(
    function* disposableSource(configDir: string) {
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
        return yield* new HeadlessSmokeError({
          message: `Invalid disposable credentials at ${store}`,
        })
      }

      if (Option.isNone(updated)) {
        return yield* new HeadlessSmokeError({
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
  offlineSource = Effect.fn("Headless.offlineSource")(function* offlineSource(
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
   * The credential source for this run: a fake one offline, the disposable
   * directory `OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR` names, or a copy of
   * a real account.
   */
  prepare = Effect.fn("Headless.prepareCredentials")(function* prepare(
    root: string,
    mode: {
      readonly offline: boolean
      readonly refreshConfigDir: Option.Option<string>
    },
  ) {
    if (mode.offline) {
      return yield* offlineSource(root)
    }

    return yield* Option.match(mode.refreshConfigDir, {
      onNone: () => copiedSource(root),
      onSome: (configDir) => disposableSource(configDir),
    })
  })

/** The credentials the smoke test hands the plugin, and the write-back check. */
export default Object.freeze({ checkWriteBack, prepare })
