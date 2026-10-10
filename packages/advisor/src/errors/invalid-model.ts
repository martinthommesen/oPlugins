import { Schema } from "effect"

/** A model reference is malformed or names no selectable model. */
class InvalidModel extends Schema.TaggedError<InvalidModel>()("InvalidModel", {
  model: Schema.String,
  reason: Schema.String,
}) {}

export { InvalidModel }
