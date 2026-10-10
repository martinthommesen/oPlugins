import { Schema } from "effect"

/** The backend rejected the requested reviewer model for this account. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class ModelUnavailable extends Schema.TaggedError<ModelUnavailable>()(
  "ModelUnavailable",
  { detail: Schema.String, model: Schema.String, status: Schema.Int },
) {}

export default ModelUnavailable
