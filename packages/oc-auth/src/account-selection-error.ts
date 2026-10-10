import { Schema } from "effect"

/**
 * `/connect` could not import a Claude Code account: none was selected, the
 * selection was not one registered at startup, or the account is gone. The
 * message is meant for the user.
 */
// oxlint-disable-next-line unicorn/throw-new-error -- `Schema.TaggedError` builds a class; nothing is thrown here.
class AccountSelectionError extends Schema.TaggedError<AccountSelectionError>()(
  "AccountSelectionError",
  { message: Schema.String },
) {}

export default AccountSelectionError
