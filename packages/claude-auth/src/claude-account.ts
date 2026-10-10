import ClaudeCredentials from "./claude-credentials.ts"
import { Schema } from "effect"

/**
 * One Claude Code account found on this machine. `source` is `file` or the
 * name of the Keychain item that holds it; `configDir` is the Claude config
 * directory it belongs to, when known.
 */
const ClaudeAccount = Schema.Struct({
  configDir: Schema.optionalKey(Schema.String),
  credentials: ClaudeCredentials,
  label: Schema.String,
  source: Schema.String,
})

export default ClaudeAccount
