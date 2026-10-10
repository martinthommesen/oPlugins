import { Effect, Match, Option } from "effect"
import ClaudeCodeStores from "./claude-code-stores.ts"
import type ClaudeCredentials from "./claude-credentials.ts"
import DebugLog from "./debug-log.ts"
import type Metadata from "./claude-credential-metadata.ts"
import RefreshResult from "./credential-refresh-result.ts"
import adoption from "./credential-adoption.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import keys from "./credential-refresh-keys.ts"
import sources from "./claude-code-sources.ts"

type Subject = Effect.Success<ReturnType<typeof keys.subjectOf>>

type Tokens = typeof ClaudeCredentials.Type

type WriteResult = Effect.Success<
  ReturnType<ClaudeCodeStores["Service"]["writeBack"]>
>

/** A refresh that got fresh tokens, and what the store held before it. */
interface Renewal {
  /** What the store held when the lock was taken, if it could be read. */
  readonly prior: Option.Option<Tokens>
  readonly subject: Subject
  readonly tokens: Tokens
}

/* The store `metadata` names, for a message to the user. */
const describeSource = (metadata: typeof Metadata.Type): string => {
    if (metadata.source === sources.FILE_SOURCE) {
      return "the Claude Code credentials file"
    }

    return `the macOS Keychain item "${metadata.source}"`
  },
  /* The refreshed credential, matching a store that holds the token fingerprinted `hash`. */
  finish = Effect.fn("CredentialRefresh.finish")(function* finish(
    renewal: Renewal,
    written: WriteResult,
    hash: string,
  ) {
    const debugLog = yield* DebugLog,
      { metadata } = renewal.subject.credential

    yield* debugLog.log("refresh_success", {
      source: metadata.source,
      writeResult: written,
    })

    return RefreshResult.Refreshed({
      credential: claudeCodeCredential.fromSource(
        renewal.tokens,
        claudeCodeCredential.withSourceTokenHash(metadata, hash),
      ),
    })
  }),
  /*
   * Finish with the credential still matching what the store held before
   * the refresh, because the refreshed tokens did not land in it.
   */
  keepPrior = Effect.fn("CredentialRefresh.keepPrior")(function* keepPrior(
    renewal: Renewal,
    written: WriteResult,
  ) {
    const hash = yield* Option.match(renewal.prior, {
      onNone: () =>
        Effect.succeed(renewal.subject.credential.metadata.sourceTokenHash),
      onSome: (prior) => sources.tokenFingerprint(prior.accessToken),
    })

    return yield* finish(renewal, written, hash)
  }),
  /* After a conflict, adopt the winner when it can be, else keep our own refresh. */
  onConflict = Effect.fn("CredentialRefresh.onConflict")(function* onConflict(
    renewal: Renewal,
  ) {
    const winner = yield* adoption.adoptExternal(renewal.subject)

    if (RefreshResult.$is("Adopted")(winner)) {
      return winner
    }

    return yield* keepPrior(renewal, "conflict")
  }),
  /*
   * The tokens reached OpenCode but not Claude Code. OpenCode keeps
   * working; the CLI is signed out once its own token expires.
   */
  onFailedWrite = Effect.fn("CredentialRefresh.onFailedWrite")(
    function* onFailedWrite(
      renewal: Renewal,
      written: "failed" | "unavailable",
    ) {
      const debugLog = yield* DebugLog,
        { metadata } = renewal.subject.credential

      yield* debugLog.warn("refresh_writeback_failed", {
        reason: written,
        source: metadata.source,
        warning: `refreshed Claude Code credentials could not be saved to ${describeSource(metadata)}. OpenCode keeps working, but the \`claude\` CLI will need to sign in again once its current token expires.`,
      })

      return yield* keepPrior(renewal, written)
    },
  ),
  /*
   * Finish a refresh that got `renewal.tokens`: write them back into the
   * store they came from, guarded by what it held when the refresh started.
   */
  settleRefresh = Effect.fn("CredentialRefresh.settleRefresh")(
    function* settleRefresh(renewal: Renewal) {
      const stores = yield* ClaudeCodeStores,
        { credential } = renewal.subject

      yield* keys.clearOutcome(renewal.subject)

      return yield* stores
        .writeBack({
          configDir: keys.configDirOf(credential.metadata),
          credentials: renewal.tokens,
          expectedAccessToken: Option.match(renewal.prior, {
            onNone: () => credential.access,
            onSome: (prior) => prior.accessToken,
          }),
          source: credential.metadata.source,
        })
        .pipe(
          Effect.flatMap((written: WriteResult) =>
            Match.value(written).pipe(
              Match.when("written", () =>
                sources
                  .tokenFingerprint(renewal.tokens.accessToken)
                  .pipe(
                    Effect.flatMap((hash) => finish(renewal, written, hash)),
                  ),
              ),
              Match.when("conflict", () => onConflict(renewal)),
              Match.whenOr("failed", "unavailable", (failed) =>
                onFailedWrite(renewal, failed),
              ),
              Match.exhaustive,
            ),
          ),
        )
    },
  )

/** Write-back of refreshed tokens, and what its result means for the credential. */
export default Object.freeze({ completeRefresh: settleRefresh })
