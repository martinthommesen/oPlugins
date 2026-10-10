import { Schema } from "effect"

/** A check of the packed-package smoke test failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HeadlessSmokeError extends Schema.TaggedError<HeadlessSmokeError>()(
  "HeadlessSmokeError",
  { message: Schema.String },
) {}

export default HeadlessSmokeError
