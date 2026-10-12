import { Crypto, Effect, Option, Path } from "effect"
import Environment from "./environment.ts"
import { Hex } from "effect/encoding"

const FILE_SOURCE = "file",
  FINGERPRINT_LENGTH = 32,
  /** Item names Claude Code creates. The plugin touches no other item. */
  KEYCHAIN_SERVICE_PATTERN = /^Claude Code-credentials(?:-[0-9a-f]+)?$/u,
  PRIMARY_SERVICE = "Claude Code-credentials",
  START = 0,
  SUFFIX_LENGTH = 8,
  /* The config directory Claude Code uses when `CLAUDE_CONFIG_DIR` is unset. */
  claudeHomeDir = Effect.gen(function* claudeHomeDir() {
    const environment = yield* Environment,
      path = yield* Path.Path

    return path.join(environment.variables.home, ".claude")
  }),
  codec = new TextEncoder(),
  /* `configDir`, else `CLAUDE_CONFIG_DIR`, else the primary one, resolved. */
  configDirOf = Effect.fn("ClaudeCodeSources.resolveConfigDir")(
    function* configDirOf(configDir: Option.Option<string>) {
      const environment = yield* Environment,
        path = yield* Path.Path,
        primary = yield* claudeHomeDir

      return path.resolve(
        Option.getOrElse(
          Option.orElse(configDir, () => environment.variables.claudeConfigDir),
          () => primary,
        ),
      )
    },
  ),
  /* A stable key for the store `source` names, so two stores never share one. */
  credentialSourceID = (
    source: string,
    configDir: Option.Option<string>,
  ): Effect.Effect<string, never, Environment | Path.Path> => {
    if (source !== FILE_SOURCE) {
      return Effect.succeed(`keychain:${source}`)
    }

    return configDirOf(configDir).pipe(Effect.map((dir) => `file:${dir}`))
  },
  /*
   * SHA-256 of `text` as lowercase hex. A failing digest is a broken
   * platform rather than anything a caller could handle.
   */
  digestHex = Effect.fn("ClaudeCodeSources.digestHex")(function* digestHex(
    text: string,
  ) {
    const platformCrypto = yield* Crypto.Crypto

    return Hex.encode(
      yield* platformCrypto.digest("SHA-256", codec.encode(text)),
    )
  }, Effect.orDie),
  /*
   * Whether `source` names a Claude Code store, which the plugin may read and
   * write. Credential metadata comes back from OpenCode, so it is checked
   * when it is decoded, and again before anything reaches a subprocess.
   */
  isKnownCredentialSource = (source: string): boolean =>
    source === FILE_SOURCE || KEYCHAIN_SERVICE_PATTERN.test(source),
  /* The 8-character hash Claude Code appends to a non-primary item's name. */
  keychainSuffixForDir = (
    dir: string,
  ): Effect.Effect<string, never, Crypto.Crypto> =>
    digestHex(dir).pipe(Effect.map((hex) => hex.slice(START, SUFFIX_LENGTH))),
  /*
   * A short, non-reversible fingerprint of an access token. Credential
   * metadata and log records carry it in place of the token, so what a
   * store holds can be compared and logged without token material.
   */
  tokenFingerprint = (
    token: string,
  ): Effect.Effect<string, never, Crypto.Crypto> =>
    digestHex(token).pipe(
      Effect.map((hex) => hex.slice(START, FINGERPRINT_LENGTH)),
    )

/** Names, keys, and fingerprints of the Claude Code credential stores. */
export default Object.freeze({
  FILE_SOURCE,
  PRIMARY_SERVICE,
  credentialSourceID,
  isKnownCredentialSource,
  keychainSuffixForDir,
  primaryConfigDir: claudeHomeDir,
  resolveConfigDir: configDirOf,
  tokenFingerprint,
})
