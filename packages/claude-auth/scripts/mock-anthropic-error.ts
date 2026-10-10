import { Schema } from "effect"

/**
 * The mock Messages API saw a request the plugin should not have sent, or
 * never saw the tool round trip the smoke test drives.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class MockAnthropicError extends Schema.TaggedError<MockAnthropicError>()(
  "MockAnthropicError",
  { message: Schema.String },
) {}

export default MockAnthropicError
