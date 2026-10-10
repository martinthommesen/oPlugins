import { Schema } from "effect"

/** A call to the OpenCode server through the plugin context failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  cause: Schema.Defect(),
  operation: Schema.String,
}) {}

export default HostError
