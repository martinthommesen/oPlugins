import { Schema } from "effect"

/** The reviewer's final message held no valid assessment. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class MalformedAssessment extends Schema.TaggedError<MalformedAssessment>()(
  "MalformedAssessment",
  { text: Schema.String },
) {}

export default MalformedAssessment
