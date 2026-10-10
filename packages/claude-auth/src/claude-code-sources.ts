import { Crypto, Effect, Encoding, Option, Path } from "effect"
import Environment from "./environment.ts"

const FILE_SOURCE = "file",
  FINGERPRINT_LENGTH = 32,
  /** Service names the Claude CLI creates. Anything else is not ours to touch. */
  KEYCHAIN_SERVICE_PATTERN = /^Claude Code-credentials(?:-[0-9a-f]+)?$/u,
  PRIMARY_SERVICE = "Claude Code-credentials",
  START = 0,
  SUFFIX_LENGTH = 8,
  /* The config directory the Claude CLI uses when CLAUDE_CONFIG_DIR is unset. */
  claudeHomeDir = Effect.gen(function* claudeHomeDir() {
    const environment = yield* Environment,
      path = yield* Path.Path

    return path.join(environment.variables.home, ".claude")
  }),
  codec = new TextEncoder(),
  /* `configDir`, else CLAUDE_CONFIG_DIR, else the primary directory, resolved. */
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

    return Encoding.encodeHex(
      yield* platformCrypto.digest("SHA-256", codec.encode(text)),
    )
  }, Effect.orDie),
  /*
   * Whether `source` names a credential store this plugin owns. Credential
   * metadata round-trips through OpenCode's store, so it is checked on the
   * way back in, and again before anything reaches a subprocess.
   */
  isKnownCredentialSource = (source: string): boolean =>
    source === FILE_SOURCE || KEYCHAIN_SERVICE_PATTERN.test(source),
  /* The 8-character hash Claude Code appends to a non-primary item's name. */
  keychainSuffixForDir = (
    dir: string,
  ): Effect.Effect<string, never, Crypto.Crypto> =>
    digestHex(dir).pipe(Effect.map((hex) => hex.slice(START, SUFFIX_LENGTH))),
  /*
   * A short, non-reversible tag for an access token, so write-back decisions
   * can be correlated across log lines (and against another account's)
   * without putting token material in the log.
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
