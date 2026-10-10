import { Schema } from "effect"

/** No usable ChatGPT credential is available for the reviewer. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class AuthUnavailable extends Schema.TaggedError<AuthUnavailable>()(
  "AuthUnavailable",
  { reason: Schema.String },
) {}

export default AuthUnavailable
