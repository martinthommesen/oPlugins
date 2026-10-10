import { Data } from "effect"
import type { Effect } from "effect"

/** The cross-process refresh lock, as held by this process. */
interface HeldLock {
  /** True when the lock serializes nothing because coordination is unavailable. */
  readonly degraded: boolean
  readonly defer: (ms: number) => Effect.Effect<void>
  readonly extend: (ms: number) => Effect.Effect<boolean>
  readonly release: Effect.Effect<void>
}

type Attempt = Data.TaggedEnum<{
  Busy: object
  Cooldown: { readonly until: number }
  Held: { readonly lock: HeldLock }
}>

const LockAttempt = Data.taggedEnum<Attempt>()

/**
 * The outcome of asking for the lock. `Busy` means another process is
 * refreshing this source right now; `Cooldown` means one is waiting out a
 * failed refresh until `until`, so no new credential is on its way.
 *
 * The constructors are the tagged enum's, under lowercase names: `new-cap`
 * exempts only Effect's own namespaces from calling a capitalized function.
 */
export default Object.freeze({
  $is: LockAttempt.$is,
  $match: LockAttempt.$match,
  busy: LockAttempt.Busy,
  cooldown: LockAttempt.Cooldown,
  held: LockAttempt.Held,
})
