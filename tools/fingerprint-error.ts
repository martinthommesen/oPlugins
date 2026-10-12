import { Schema } from "effect"

/** Writing the plugins' fingerprints failed, for the reason it names. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class FingerprintError extends Schema.TaggedError<FingerprintError>()(
  "FingerprintError",
  { message: Schema.String },
) {}

export default FingerprintError
