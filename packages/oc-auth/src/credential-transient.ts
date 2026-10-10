import { Effect, Option } from "effect"
import ClaudeAuthRefreshExhaustedError from "./claude-auth-refresh-exhausted-error.ts"
import DebugLog from "./debug-log.ts"
import type LockAttempt from "./refresh-lock-attempt.ts"
import RefreshBackoff from "./refresh-backoff.ts"
import RefreshResult from "./credential-refresh-result.ts"
import type keys from "./credential-refresh-keys.ts"
import policy from "./refresh-backoff-policy.ts"

type Subject = Effect.Success<ReturnType<typeof keys.subjectOf>>

type HeldLock = (typeof LockAttempt.held extends (args: infer Args) => object
  ? Args
  : never)["lock"]

/** A refresh holding the lock for its store. */
interface Holder {
  readonly lock: HeldLock
  readonly subject: Subject
}

const NETWORK_FAILURE = 0,
  /* A transient failure, as the user is told about it. */
  describeTransient = (
    status: number,
    oauthError: Option.Option<string>,
  ): string => {
    if (status === NETWORK_FAILURE) {
      return "network error"
    }

    return Option.match(oauthError, {
      onNone: () => `HTTP ${status}`,
      onSome: (code) => `HTTP ${status}: ${code}`,
    })
  },
  /*
   * Record a transient failure, then either back off quietly or, past the
   * ceiling, tell the user. Nothing is latched: the next attempt after the
   * cooldown goes out as usual.
   */
  noteTransient = Effect.fn("CredentialRefresh.transient")(
    function* noteTransient(
      holder: Holder,
      cause: string,
      retryAfterMs: Option.Option<number>,
    ) {
      const backoff = yield* RefreshBackoff,
        cooldownMs = yield* backoff.noteTransient(
          holder.subject.sourceKey,
          retryAfterMs,
        ),
        debugLog = yield* DebugLog,
        failures = yield* backoff.transientCount(holder.subject.sourceKey)

      yield* holder.lock.defer(cooldownMs)
      yield* debugLog.log("refresh_transient", {
        cause,
        cooldownMs,
        failures,
        source: holder.subject.credential.metadata.source,
      })

      if (failures >= policy.MAX_CONSECUTIVE_TRANSIENT) {
        return yield* ClaudeAuthRefreshExhaustedError.make({
          message: ClaudeAuthRefreshExhaustedError.textFor(failures, cause),
        })
      }

      return RefreshResult.Transient({ retryAfterMs: cooldownMs })
    },
  )

/** Transient refresh failures: their description, backoff, and ceiling. */
export default Object.freeze({ describeTransient, noteTransient })
