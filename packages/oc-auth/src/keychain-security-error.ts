import { Schema } from "effect"

/**
 * A run of the macOS `security` tool that did not succeed. `errorType` is
 * `timeout`, a known exit status (`locked`, `not_found`, `denied`), or
 * `exit_<status>`. A process failure without an exit status is
 * `start_failed`, `no_exit_status` (killed by a signal), `output_failed`,
 * `input_failed`, or `process_failed`, and carries no platform message,
 * which would quote the command line and its arguments.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class KeychainSecurityError extends Schema.TaggedError<KeychainSecurityError>()(
  "KeychainSecurityError",
  { errorType: Schema.String, message: Schema.String, stderr: Schema.String },
) {}

export default KeychainSecurityError
