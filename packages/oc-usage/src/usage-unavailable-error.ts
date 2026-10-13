import { Schema } from "effect"

/** The CLI plugin couldn't get an answer from the server plugin's RPC. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class UsageUnavailable extends Schema.TaggedError<UsageUnavailable>()(
  "UsageUnavailable",
  { message: Schema.String },
) {}

export default UsageUnavailable
