import { Schema } from "effect"

/**
 * One ticket file as a scan sees it. `cooldown` marks a lease held through
 * `defer`, after a failed refresh, rather than for one.
 */
const RefreshLockClaim = Schema.Struct({
  cooldown: Schema.Boolean,
  expiresAt: Schema.Finite,
  path: Schema.String,
  ticket: Schema.BigInt,
})

export default RefreshLockClaim
