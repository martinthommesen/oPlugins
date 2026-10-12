import { Data } from "effect"
import type { Effect } from "effect"

/** The cross-process refresh lock, as held by this process. */
interface HeldLock {
  /** True when the lock serializes nothing because coordination is unavailable. */
  readonly degraded: boolean
  /**
   * Lease the lock for `ms` from now as a cooldown claim, which outlives
   * `release`. A lease that can't be written makes no claim.
   */
  readonly defer: (ms: number) => Effect.Effect<void>
  /**
   * Lease the lock for `ms` from now; false when it no longer belongs to this
   * process or the lease can't be written.
   */
  readonly extend: (ms: number) => Effect.Effect<boolean>
  /** Close the ticket, ending its lease unless `defer` made it a cooldown claim. */
  readonly release: Effect.Effect<void>
}

type Attempt = Data.TaggedEnum<{
  Busy: object
  Cooldown: { readonly until: number }
  Held: { readonly lock: HeldLock }
}>

/**
 * The outcome of asking for the refresh lock. `Busy` means another process
 * is refreshing the store's credential right now; `Cooldown` means one is
 * waiting out a failed refresh until `until`, so no new credential is coming.
 */
export default Data.taggedEnum<Attempt>()
