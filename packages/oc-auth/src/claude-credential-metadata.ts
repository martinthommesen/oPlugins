import { Schema } from "effect"
import sources from "./claude-code-sources.ts"

/**
 * What this plugin keeps in an OpenCode credential's metadata, which ties the
 * credential to its Claude Code store. It never holds token material.
 *
 * Metadata comes back from OpenCode, so decoding it checks that `source`
 * names a Claude Code store.
 */
const ClaudeCredentialMetadata = Schema.Struct({
  /** The account's label, which `/connect` showed. */
  accountLabel: Schema.String,
  /** The Claude Code config directory of the account, when known. */
  configDir: Schema.optionalKey(Schema.String),
  /** The `source` that names the account's store. */
  source: Schema.String.check(
    Schema.makeFilter((source: string) =>
      sources.isKnownCredentialSource(source),
    ),
  ),
  /** The fingerprint of the access token the store held when last matched. */
  sourceTokenHash: Schema.String,
})

export default ClaudeCredentialMetadata
