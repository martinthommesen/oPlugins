import { Schema } from "effect"

/** The advisor model did not answer before the configured deadline. */
class ConsultationTimedOut extends Schema.TaggedError<ConsultationTimedOut>()(
  "ConsultationTimedOut",
  {
    model: Schema.String,
    seconds: Schema.Number,
  },
) {}

export { ConsultationTimedOut }
