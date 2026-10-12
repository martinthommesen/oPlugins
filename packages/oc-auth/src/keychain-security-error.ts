import { Schema } from "effect"

/**
 * A run of the macOS `security` tool that did not succeed. `errorType` is
 * `timeout`, a known exit status (`locked`, `not_found`, `denied`),
 * `exit_<status>`, or `exit_unknown` for a run without an exit status.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class KeychainSecurityError extends Schema.TaggedError<KeychainSecurityError>()(
  "KeychainSecurityError",
  { errorType: Schema.String, message: Schema.String, stderr: Schema.String },
) {}

export default KeychainSecurityError
