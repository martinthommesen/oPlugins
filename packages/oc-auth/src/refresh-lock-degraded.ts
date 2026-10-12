import { Effect } from "effect"
import LockAttempt from "./refresh-lock-attempt.ts"
import pluginLog from "./plugin-log.ts"

/*
 * The lock granted when the lock directory, or a ticket in it, can't be
 * examined. `extend` reports success because failing every refresh on a
 * machine with an unusable lock directory would be worse than an
 * uncoordinated refresh.
 */
const DEGRADED_LOCK = {
  defer: (): Effect.Effect<void> => Effect.void,
  degraded: true,
  extend: (): Effect.Effect<boolean> => Effect.succeed(true),
  release: Effect.void,
}

/*
 * Grant the uncoordinated lock on the store `target` names, and warn: two
 * processes refreshing at once can sign Claude Code out, so the lock
 * directory needs fixing. The warning names the store by its lock name; only
 * the debug record carries `source`, which can hold a path.
 */
export default Effect.fn("RefreshLock.degrade")(function* degrade(
  target: { readonly lock: string; readonly source: string },
  failure: { readonly message: string },
) {
  yield* pluginLog.warning("refresh_lock_degraded", { lock: target.lock })
  yield* pluginLog.debug("refresh_lock_degraded", {
    error: failure.message,
    lock: target.lock,
    source: target.source,
  })

  return LockAttempt.Held({ lock: DEGRADED_LOCK })
})
