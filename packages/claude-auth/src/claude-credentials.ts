import { Schema } from "effect"

const MINIMUM_EXCLUSIVE = 0,
  /** A token as Claude Code stores it: present and not blank. */
  NonBlank = Schema.String.check(Schema.isPattern(/\S/u)),
  /**
   * The OAuth credentials Claude Code stores for one account. `expiresAt` is
   * epoch milliseconds.
   */
  TokenPair = Schema.Struct({
    accessToken: NonBlank,
    expiresAt: Schema.Finite.check(Schema.isGreaterThan(MINIMUM_EXCLUSIVE)),
    refreshToken: NonBlank,
    subscriptionType: Schema.optionalKey(Schema.String),
  })

export default TokenPair
