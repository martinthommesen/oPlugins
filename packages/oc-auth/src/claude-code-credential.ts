import { Option, Schema, Struct } from "effect"
import type ClaudeCredentials from "./claude-credentials.ts"
import type { Credential } from "@opencode/plugin/effect"
import Metadata from "./claude-credential-metadata.ts"

type Tokens = Pick<
  typeof ClaudeCredentials.Type,
  "accessToken" | "expiresAt" | "refreshToken"
>

type ClaudeMetadata = typeof Metadata.Type

/** The parts of an OpenCode OAuth credential this plugin reads. */
type OAuthParts = Pick<
  Credential.OAuth,
  "access" | "expires" | "metadata" | "refresh"
>

/**
 * An OpenCode credential this plugin imported, with its metadata decoded.
 * `toOAuth` turns it into the credential the host stores.
 */
interface ClaudeCodeCredential {
  /** The OAuth access token. */
  readonly access: string
  /** When `access` expires, in epoch milliseconds. */
  readonly expires: number
  /** The metadata that ties the credential to its Claude Code store. */
  readonly metadata: ClaudeMetadata
  /** The OAuth refresh token. */
  readonly refresh: string
}

const CLAUDE_CODE_METHOD = "claude-code",
  /** A host credential value this plugin imported, decoded to the parts it uses. */
  HostClaudeCode = Schema.Struct({
    access: Schema.String,
    expires: Schema.Finite,
    metadata: Metadata,
    methodID: Schema.Literal(CLAUDE_CODE_METHOD),
    refresh: Schema.String,
    type: Schema.Literal("oauth"),
  }),
  INTEGRATION_ID = "anthropic",
  IntegrationMethodID = Schema.String.pipe(
    Schema.brand("Integration.MethodID"),
  ),
  /** The OAuth method this plugin registers, as the host brands it. */
  METHOD_ID = IntegrationMethodID.make(CLAUDE_CODE_METHOD),
  asMetadata = Schema.decodeUnknownOption(Metadata),
  /* The account label `credential` was imported with, if any. */
  credentialLabel = (
    credential: Pick<Credential.OAuth, "metadata">,
  ): string | undefined =>
    asMetadata(credential.metadata).pipe(
      Option.map((metadata) => metadata.accountLabel),
      Option.getOrUndefined,
    ),
  /*
   * A host credential value as this plugin's, or none when it is a key, an
   * environment connection, another method's OAuth, or absent.
   */
  decodeHostValue = Schema.decodeUnknownOption(HostClaudeCode),
  /* `credential` as this plugin's, or none when it carries no metadata of ours. */
  fromOAuth = (credential: OAuthParts): Option.Option<ClaudeCodeCredential> =>
    asMetadata(credential.metadata).pipe(
      Option.map((metadata) => ({
        access: credential.access,
        expires: credential.expires,
        metadata,
        refresh: credential.refresh,
      })),
    ),
  /* A credential holding `tokens` from a store, tagged with `metadata`. */
  fromSource = (
    tokens: Tokens,
    metadata: ClaudeMetadata,
  ): ClaudeCodeCredential => ({
    access: tokens.accessToken,
    expires: Math.trunc(tokens.expiresAt),
    metadata,
    refresh: tokens.refreshToken,
  }),
  /* This plugin's metadata on `credential`, or none when it carries none. */
  readMetadata = (
    credential: Pick<Credential.OAuth, "metadata">,
  ): Option.Option<ClaudeMetadata> => asMetadata(credential.metadata),
  /* The OpenCode credential the host stores for `credential`. */
  toOAuth = (credential: ClaudeCodeCredential): Credential.OAuth => ({
    access: credential.access,
    expires: credential.expires,
    metadata: credential.metadata,
    methodID: METHOD_ID,
    refresh: credential.refresh,
    type: "oauth",
  }),
  /* `metadata` matching a store that holds the token fingerprinted `hash`. */
  withSourceTokenHash = (
    metadata: ClaudeMetadata,
    hash: string,
  ): ClaudeMetadata => Struct.assign(metadata, { sourceTokenHash: hash })

/**
 * OpenCode credentials imported from Claude Code: the integration and method
 * they belong to, and the metadata that ties each to its Claude Code store.
 */
export default Object.freeze({
  INTEGRATION_ID,
  METHOD_ID,
  credentialLabel,
  decodeHostValue,
  fromOAuth,
  fromSource,
  readMetadata,
  toOAuth,
  withSourceTokenHash,
})
