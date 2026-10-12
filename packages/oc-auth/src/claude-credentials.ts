import { Schema } from "effect"

const MINIMUM_EXCLUSIVE = 0,
  /** A token as Claude Code stores it: present and not blank. */
  NonBlank = Schema.String.check(Schema.isPattern(/\S/u)),
  /** The OAuth credentials Claude Code stores for one account. */
  TokenPair = Schema.Struct({
    /** The OAuth access token. */
    accessToken: NonBlank,
    /** When the access token expires, in epoch milliseconds. */
    expiresAt: Schema.Finite.check(Schema.isGreaterThan(MINIMUM_EXCLUSIVE)),
    /** The OAuth refresh token. */
    refreshToken: NonBlank,
    /** The subscription tier, such as `pro` or `max`. */
    subscriptionType: Schema.optionalKey(Schema.String),
  })

export default TokenPair
