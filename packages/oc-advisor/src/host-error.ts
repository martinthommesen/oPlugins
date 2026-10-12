import { Schema } from "effect"

/** A call to the host through the plugin context failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  /** What the host call failed with. It may quote the conversation. */
  cause: Schema.Defect(),
  /** The plugin context call that failed, such as `session.generate`. */
  operation: Schema.String,
}) {}

export default HostError
