import { Data } from "effect"
import type claudeCodeCredential from "./claude-code-credential.ts"

type ClaudeCodeCredential = ReturnType<typeof claudeCodeCredential.fromSource>

/*
 * What asking to adopt or refresh a credential came to. `Unchanged` and
 * `Transient` mean the caller keeps the credential it asked with; `Transient`
 * says how long to wait before asking again. `Adopted` carries a credential
 * Claude Code rotated outside OpenCode, `Refreshed` one this plugin renewed.
 */
type RefreshResult =
  | { readonly _tag: "Adopted"; readonly credential: ClaudeCodeCredential }
  | { readonly _tag: "Refreshed"; readonly credential: ClaudeCodeCredential }
  | { readonly _tag: "Transient"; readonly retryAfterMs: number }
  | { readonly _tag: "Unchanged" }

/** Builds and matches the results of adopting or refreshing a credential. */
export default Data.taggedEnum<RefreshResult>()
