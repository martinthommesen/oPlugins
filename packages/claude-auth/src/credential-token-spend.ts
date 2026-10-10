import { Effect, Option, Result } from "effect"
import ClaudeCodeStores from "./claude-code-stores.ts"
import type LockAttempt from "./refresh-lock-attempt.ts"
import TokenExchange from "./token-exchange.ts"
import adoption from "./credential-adoption.ts"
import gate from "./credential-refresh-gate.ts"
import keys from "./credential-refresh-keys.ts"
import sources from "./claude-code-sources.ts"
import transient from "./credential-transient.ts"
import writeBack from "./credential-write-back.ts"

type Subject = Effect.Success<ReturnType<typeof keys.subjectOf>>

type Tokens = ReturnType<typeof TokenExchange.Outcome.Ok>["credentials"]

type HeldLock = (typeof LockAttempt.held extends (args: infer Args) => object
  ? Args
  : never)["lock"]

type Outcome = Effect.Success<ReturnType<TokenExchange["Service"]["exchange"]>>

/** A refresh holding the lock, and what the store held when it was taken. */
interface Turn {
  readonly lock: HeldLock
  readonly prior: Option.Option<Tokens>
  readonly subject: Subject
}

// Room for the exchange to finish and its result to be written back.
const LEASE_MARGIN_MS = 15_000,
  /*
   * The refresh token `turn` spends: the one in the store when the store
   * moved on since the credential last matched it, else the credential's own.
   */
  refreshTokenFor = Effect.fn("CredentialRefresh.refreshTokenFor")(
    function* refreshTokenFor(turn: Turn) {
      const { credential } = turn.subject,
        rotated = yield* Option.match(turn.prior, {
          onNone: () => Effect.succeedNone,
          onSome: (prior) =>
            sources
              .tokenFingerprint(prior.accessToken)
              .pipe(
                Effect.map((hash) =>
                  Option.some(prior).pipe(
                    Option.filter(
                      () => hash !== credential.metadata.sourceTokenHash,
                    ),
                  ),
                ),
              ),
        })

      return Option.match(rotated, {
        onNone: () => credential.refresh,
        onSome: (prior) => prior.refreshToken,
      })
    },
  ),
  /* What the token endpoint's `outcome` means for the refresh of `turn`. */
  settleOutcome = Effect.fn("CredentialRefresh.settleOutcome")(
    function* settleOutcome(turn: Turn, outcome: Outcome) {
      return yield* TokenExchange.Outcome.$match(outcome, {
        Ok: ({ credentials }) =>
          writeBack.completeRefresh({
            prior: turn.prior,
            subject: turn.subject,
            tokens: credentials,
          }),
        Terminal: (terminal) => gate.rejected(turn.subject, terminal),
        Transient: (failure) =>
          transient.noteTransient(
            turn,
            transient.describeTransient(failure.status, failure.oauthError),
            failure.retryAfterMs,
          ),
      })
    },
  ),
  /*
   * Spend the refresh token, unless the lease cannot cover the exchange:
   * then another process may already be refreshing, so wait for its result
   * rather than spend a refresh token this process cannot hold.
   */
  spendToken = Effect.fn("CredentialRefresh.spendToken")(function* spendToken(
    turn: Turn,
  ) {
    const extended = yield* turn.lock.extend(
        TokenExchange.timeoutMs + LEASE_MARGIN_MS,
      ),
      refreshToken = yield* refreshTokenFor(turn),
      tokenExchange = yield* TokenExchange

    if (!extended) {
      return yield* adoption.waitForExternal(turn.subject)
    }

    return yield* settleOutcome(
      turn,
      yield* tokenExchange.exchange(refreshToken),
    )
  }),
  /*
   * With the lock held, adopt what the store holds now; else, unless the
   * refresh became blocked meanwhile, spend the refresh token.
   */
  verifySource = Effect.fn("CredentialRefresh.verifySource")(
    function* verifySource(turn: Turn) {
      const adopted = yield* adoption.adoptStored(turn.subject, turn.prior)

      if (gate.wasAdopted(adopted)) {
        return adopted
      }

      return yield* gate.unlessBlocked(turn.subject, () => spendToken(turn))
    },
  ),
  /* Refresh `subject` holding `lock`, starting from what its store holds now. */
  whileHeld = Effect.fn("CredentialRefresh.whileHeld")(function* whileHeld(
    subject: Subject,
    lock: HeldLock,
  ) {
    const { metadata } = subject.credential,
      stores = yield* ClaudeCodeStores,
      tokensNow = yield* stores
        .readSource(metadata.source, keys.configDirOf(metadata))
        .pipe(Effect.result)

    return yield* Result.match(tokensNow, {
      /*
       * Refreshing blind would rotate the token Claude Code holds with no
       * way to write the replacement back. That would sign the CLI out.
       */
      onFailure: (failure: { readonly message: string }) =>
        transient.noteTransient(
          { lock, subject },
          `Claude Code credentials could not be read: ${failure.message}`,
          Option.none(),
        ),
      onSuccess: (prior) => verifySource({ lock, prior, subject }),
    })
  })

/** The refresh proper, once the lock is held. */
export default Object.freeze({ refreshHeld: whileHeld })
