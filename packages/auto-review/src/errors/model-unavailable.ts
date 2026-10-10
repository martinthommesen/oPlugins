import { Schema } from "effect"

/** The backend rejected the requested reviewer model for this account. */
class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()(
  "ModelUnavailable",
  { detail: Schema.String, model: Schema.String, status: Schema.Int },
) {}

export { ModelUnavailable }
