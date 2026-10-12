import { Schema } from "effect"
import hostFailure from "@oc-lib/host-failure/host-failure.ts"

/** A call to the host through the plugin context failed. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class HostError extends Schema.TaggedError<HostError>()("HostError", {
  /** Why the host call failed, as far as the host's failure says. */
  category: hostFailure.Category,
  /** What the host call failed with. It may quote the conversation. */
  cause: Schema.Defect(),
  /** The plugin context call that failed, such as `session.generate`. */
  operation: Schema.String,
}) {}

export default HostError
