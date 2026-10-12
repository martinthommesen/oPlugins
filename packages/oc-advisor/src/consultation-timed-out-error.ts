import { Schema } from "effect"

/** The advisor model did not answer before the configured deadline. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ConsultationTimedOut extends Schema.TaggedError<ConsultationTimedOut>()(
  "ConsultationTimedOut",
  {
    /** The advisor model that did not answer in time. */
    model: Schema.String,
    /** The deadline, in seconds. */
    seconds: Schema.Finite,
  },
) {}

export default ConsultationTimedOut
