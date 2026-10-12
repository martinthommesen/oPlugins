import ClaudeCredentials from "./claude-credentials.ts"
import { Schema } from "effect"

/** One Claude Code account found on this machine. */
const ClaudeAccount = Schema.Struct({
  /** The Claude Code config directory the account belongs to, if known. */
  configDir: Schema.optionalKey(Schema.String),
  /** The credentials the account's store held when it was read. */
  credentials: ClaudeCredentials,
  /** The label that tells the account apart in `/connect`. */
  label: Schema.String,
  /** The `source` that names its store: `file`, or a Keychain item's name. */
  source: Schema.String,
})

export default ClaudeAccount
