import { Schema } from "effect"

/**
 * The outbound request's body could not be read, so it could not be
 * rewritten for subscription billing.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class RequestBodyError extends Schema.TaggedError<RequestBodyError>()(
  "RequestBodyError",
  { cause: Schema.Defect(), message: Schema.String },
) {}

export default RequestBodyError
