import type { Crypto, Path } from "effect"
import { Effect, Option } from "effect"
import type Environment from "./environment.ts"
import type Metadata from "./claude-credential-metadata.ts"
import RefreshBackoff from "./refresh-backoff.ts"
import type claudeCodeCredential from "./claude-code-credential.ts"
import sources from "./claude-code-sources.ts"

type ClaudeCodeCredential = ReturnType<typeof claudeCodeCredential.fromSource>

/** One credential to adopt or refresh, and the keys its state lives under. */
interface Subject {
  readonly credential: ClaudeCodeCredential
  /** One credential generation of one store: terminal failures latch here. */
  readonly credentialKey: string
  /** One store: cooldowns and in-flight refreshes are shared here. */
  readonly sourceKey: string
}

const KEY_SEPARATOR = ":",
  /* Clear the backoff state kept for `subject`. */
  clearOutcome = Effect.fn("CredentialRefresh.clearOutcome")(
    function* clearOutcome(subject: Subject) {
      const backoff = yield* RefreshBackoff

      yield* backoff.clear(subject.credentialKey)
      yield* backoff.clear(subject.sourceKey)
    },
  ),
  /* The config directory `metadata` names, if any. */
  configDirOf = (metadata: typeof Metadata.Type): Option.Option<string> =>
    Option.fromUndefinedOr(metadata.configDir),
  /* `credential` as the subject of a refresh, keyed by its store and generation. */
  subjectOf = Effect.fn("CredentialRefresh.subjectOf")(function* subjectOf(
    credential: ClaudeCodeCredential,
  ): Effect.fn.Return<Subject, never, Crypto.Crypto | Environment | Path.Path> {
    const fingerprint = yield* sources.tokenFingerprint(credential.access),
      sourceKey = yield* sources.credentialSourceID(
        credential.metadata.source,
        configDirOf(credential.metadata),
      )

    return {
      credential,
      credentialKey: [
        sourceKey,
        credential.metadata.sourceTokenHash,
        fingerprint,
      ].join(KEY_SEPARATOR),
      sourceKey,
    }
  })

/** What one credential refresh is about, and the keys its state lives under. */
export default Object.freeze({ clearOutcome, configDirOf, subjectOf })
