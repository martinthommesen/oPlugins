import { Schema } from "effect"

/** A step of the headless host test failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HostTestError extends Schema.TaggedError<HostTestError>()(
  "HostTestError",
  { message: Schema.String },
) {}

export default HostTestError
