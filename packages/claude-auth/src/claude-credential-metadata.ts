import { Schema } from "effect"
import sources from "./claude-code-sources.ts"

/**
 * What this plugin stores in an OpenCode credential's metadata: the Claude
 * Code store it came from, its label, and a fingerprint of the access token
 * that store held when the credential last matched it. Never token material.
 *
 * `source` is validated here, at the one gate every consumer passes through,
 * rather than at each place that hands it to a subprocess.
 */
const ClaudeCredentialMetadata = Schema.Struct({
  accountLabel: Schema.String,
  configDir: Schema.optionalKey(Schema.String),
  source: Schema.String.check(
    Schema.makeFilter((source: string) =>
      sources.isKnownCredentialSource(source),
    ),
  ),
  sourceTokenHash: Schema.String,
})

export default ClaudeCredentialMetadata
