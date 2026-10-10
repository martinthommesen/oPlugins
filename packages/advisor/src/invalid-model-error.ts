import { Schema } from "effect"

/** A model reference is malformed or names no selectable model. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class InvalidModel extends Schema.TaggedError<InvalidModel>()("InvalidModel", {
  model: Schema.String,
  reason: Schema.String,
}) {}

export default InvalidModel
