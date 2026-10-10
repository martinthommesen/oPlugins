import { Clock, Effect, Option, Schedule } from "effect"
import ClaudeCodeStores from "./claude-code-stores.ts"
import type ClaudeCredentials from "./claude-credentials.ts"
import DebugLog from "./debug-log.ts"
import RefreshResult from "./credential-refresh-result.ts"
import claudeCodeCredential from "./claude-code-credential.ts"
import keys from "./credential-refresh-keys.ts"
import sources from "./claude-code-sources.ts"

type Subject = Effect.Success<ReturnType<typeof keys.subjectOf>>

type Result = ReturnType<
  (typeof RefreshResult)["Adopted" | "Refreshed" | "Transient" | "Unchanged"]
>

type Tokens = typeof ClaudeCredentials.Type

const LOCK_ADOPT_POLL_MS = 250,
  LOCK_ADOPT_WAIT_MS = 5000,
  /** Suggested wait when another process's refresh did not land in time. */
  REFRESH_IN_PROGRESS_RETRY_MS = 5000,
  /* Adopt `tokens`, fingerprinted `hash`, in place of the credential of `subject`. */
  acceptTokens = Effect.fn("CredentialRefresh.acceptTokens")(
    function* acceptTokens(subject: Subject, tokens: Tokens, hash: string) {
      const debugLog = yield* DebugLog,
        { metadata } = subject.credential

      yield* keys.clearOutcome(subject)
      yield* debugLog.log("credential_adopted", { source: metadata.source })

      return RefreshResult.Adopted({
        credential: claudeCodeCredential.fromSource(
          tokens,
          claudeCodeCredential.withSourceTokenHash(metadata, hash),
        ),
      })
    },
  ),
  /* The credentials in `stored` that have not expired yet. */
  activeTokens = (
    stored: Option.Option<Tokens>,
  ): Effect.Effect<Option.Option<Tokens>> =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) =>
        stored.pipe(Option.filter((tokens) => tokens.expiresAt > now)),
      ),
    ),
  /*
   * The credentials the store of `subject` holds now, or none when it holds
   * none or cannot be read.
   */
  actualSource = Effect.fn("CredentialRefresh.readSource")(
    function* actualSource(subject: Subject) {
      const debugLog = yield* DebugLog,
        { metadata } = subject.credential,
        stores = yield* ClaudeCodeStores

      return yield* stores
        .readSource(metadata.source, keys.configDirOf(metadata))
        .pipe(
          Effect.catchTag(
            "ClaudeCodeStoreError",
            (failure: { readonly message: string }) =>
              debugLog
                .log("source_read_failed", {
                  error: failure.message,
                  source: metadata.source,
                })
                .pipe(Effect.as(Option.none<Tokens>())),
          ),
        )
    },
  ),
  /* Adopt the usable `tokens` unless the credential of `subject` already matches them. */
  adoptDistinct = Effect.fn("CredentialRefresh.adoptDistinct")(
    function* adoptDistinct(subject: Subject, tokens: Tokens) {
      const hash = yield* sources.tokenFingerprint(tokens.accessToken)

      if (hash === subject.credential.metadata.sourceTokenHash) {
        return RefreshResult.Unchanged()
      }

      return yield* acceptTokens(subject, tokens, hash)
    },
  ),
  /*
   * Adopt `stored`, what the store of `subject` holds, when it is usable and
   * is not what the credential of `subject` already came from.
   */
  adoptFrom = Effect.fn("CredentialRefresh.adoptStored")(function* adoptFrom(
    subject: Subject,
    stored: Option.Option<Tokens>,
  ) {
    return yield* Option.match(yield* activeTokens(stored), {
      onNone: () => Effect.succeed<Result>(RefreshResult.Unchanged()),
      onSome: (tokens) => adoptDistinct(subject, tokens),
    })
  }),
  /* Adopt a credential rotated outside OpenCode into the store of `subject`. */
  adoptNow = Effect.fn("CredentialRefresh.adoptExternal")(function* adoptNow(
    subject: Subject,
  ) {
    return yield* adoptFrom(subject, yield* actualSource(subject))
  }),
  isAdopted = RefreshResult.$is("Adopted"),
  /*
   * Poll the store every 250 ms for 5 seconds, until the credential another
   * process is refreshing lands.
   */
  pollWhileRefreshing = Schedule.spaced(LOCK_ADOPT_POLL_MS).pipe(
    Schedule.while(({ elapsed }) => elapsed < LOCK_ADOPT_WAIT_MS),
  ),
  stillRefreshing = RefreshResult.Transient({
    retryAfterMs: REFRESH_IN_PROGRESS_RETRY_MS,
  }),
  /*
   * Wait for the credential another process is refreshing, or say how long
   * to wait before asking again when it does not land in time.
   */
  waitForExternal = Effect.fn("CredentialRefresh.waitForExternal")(
    function* waitForExternal(subject: Subject) {
      const last = yield* adoptNow(subject).pipe(
        Effect.repeat({
          schedule: pollWhileRefreshing,
          until: (result: Result): boolean => isAdopted(result),
        }),
      )

      return Option.getOrElse(
        Option.liftPredicate(last, isAdopted),
        (): Result => stillRefreshing,
      )
    },
  )

/** Adoption of credentials Claude Code rotated outside OpenCode. */
export default Object.freeze({
  adoptExternal: adoptNow,
  adoptStored: adoptFrom,
  waitForExternal,
})
