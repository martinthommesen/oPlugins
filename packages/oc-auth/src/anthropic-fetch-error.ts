import { Schema } from "effect"

/** Replaying a request to the Anthropic API failed before any response. */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class AnthropicFetchError extends Schema.TaggedError<AnthropicFetchError>()(
  "AnthropicFetchError",
  { cause: Schema.Defect(), message: Schema.String },
) {}

export default AnthropicFetchError
