import { Schema } from "effect"

/** A model reference is malformed or names no selectable model. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class InvalidModel extends Schema.TaggedError<InvalidModel>()("InvalidModel", {
  /** The model reference as the user wrote it. */
  model: Schema.String,
  /** What is wrong with the reference. */
  reason: Schema.String,
}) {}

export default InvalidModel
