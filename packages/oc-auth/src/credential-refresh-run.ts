import { Clock, Effect } from "effect"
import DebugLog from "./debug-log.ts"
import LockAttempt from "./refresh-lock-attempt.ts"
import RefreshLock from "./refresh-lock.ts"
import RefreshResult from "./credential-refresh-result.ts"
import adoption from "./credential-adoption.ts"
import gate from "./credential-refresh-gate.ts"
import type keys from "./credential-refresh-keys.ts"
import tokenSpend from "./credential-token-spend.ts"

type Subject = Effect.Success<ReturnType<typeof keys.subjectOf>>

const NO_WAIT = 0,
  /* Another process failed and is backing off, so no credential is coming. */
  cooldownElsewhere = Effect.fn("CredentialRefresh.cooldownElsewhere")(
    function* cooldownElsewhere(subject: Subject, until: number) {
      const debugLog = yield* DebugLog,
        now = yield* Clock.currentTimeMillis,
        retryAfterMs = Math.max(NO_WAIT, until - now)

      yield* debugLog.log("refresh_cooldown_elsewhere", {
        retryAfterMs,
        source: subject.credential.metadata.source,
      })

      return RefreshResult.Transient({ retryAfterMs })
    },
  ),
  /* Ask for the cross-process lock on the store of `subject`, and act on the answer. */
  withAttempt = Effect.fn("CredentialRefresh.withAttempt")(
    function* withAttempt(subject: Subject) {
      const acquired = yield* (yield* RefreshLock).acquire(subject.sourceKey)

      return yield* LockAttempt.$match(acquired, {
        Busy: () => adoption.waitForExternal(subject),
        Cooldown: ({ until }) => cooldownElsewhere(subject, until),
        Held: ({ lock }) => tokenSpend.refreshHeld(subject, lock),
      })
    },
  ),
  /*
   * One refresh of `subject`. A credential rotated outside OpenCode is
   * adopted first, before any cooldown can turn the refresh away. A lock
   * this takes is released when the refresh ends, on every path.
   */
  withLockScope = Effect.fn("CredentialRefresh.performRefresh")(
    function* withLockScope(subject: Subject) {
      const adopted = yield* adoption.adoptExternal(subject)

      if (gate.wasAdopted(adopted)) {
        return adopted
      }

      return yield* gate.unlessBlocked(subject, () => withAttempt(subject))
    },
    Effect.scoped,
  )

/** One refresh of a credential, coordinated with other processes. */
export default Object.freeze({ performRefresh: withLockScope })
