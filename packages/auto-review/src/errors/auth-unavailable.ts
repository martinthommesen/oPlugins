import { Schema } from "effect"

/** No usable ChatGPT credential is available for the reviewer. */
class AuthUnavailable extends Schema.TaggedError<AuthUnavailable>()(
  "AuthUnavailable",
  { reason: Schema.String },
) {}

export { AuthUnavailable }
