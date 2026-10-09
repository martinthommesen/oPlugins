interface ModelConfig {
  readonly ccVersion: string
  readonly sdkVersion: string
  readonly baseBetas: readonly string[]
}

const EFFORT_BETA = "effort-2025-11-24"

/**
 * Betas subscription auth cannot work without. `ANTHROPIC_BETA_FLAGS` replaces
 * the rest of the base set, but dropping these turns every request into an
 * unexplained billing rejection, so they are re-added after any override.
 */
const REQUIRED_BETAS = ["claude-code-20250219", "oauth-2025-04-20"]

// Claude Code decides per model whether to send the effort beta. The predicate
// in the 2.1.295 binary denies these legacy ids. Unknown first-party models
// still enable effort by default:
//
//   n.includes("claude-3-") || n === "claude-opus-4-0" ||
//   n === "claude-opus-4-1" || n === "claude-sonnet-4-0" ||
//   n === "claude-sonnet-4-5" || n === "claude-haiku-4-5"
//
// Mirroring the denylist keeps new models correct by default; an allowlist
// silently drops the flag for every model released after its last refresh.
// Dated snapshots and the context suffix are stripped before exact matching;
// substring matches would deny future versions such as
// claude-sonnet-4-50. That stripping is why the set also holds the bare
// `claude-opus-4` and `claude-sonnet-4`: they are what `claude-opus-4-20250514`
// and `claude-sonnet-4-20250514` (the 4.0 releases) reduce to. The CLI's
// `includes("claude-3-")` becomes `startsWith` on the canonical id, which is
// the same test for first-party ids.
const NO_EFFORT_MODELS = new Set([
  "claude-opus-4",
  "claude-opus-4-0",
  "claude-opus-4-1",
  "claude-sonnet-4",
  "claude-sonnet-4-0",
  "claude-sonnet-4-5",
  "claude-haiku-4-5",
])

/** Frozen because every request shares it, so no importer may change it. */
export const config: ModelConfig = Object.freeze({
  // Header and billing shape checked against the published native CLI bundle.
  ccVersion: "2.1.295",
  // @anthropic-ai/sdk version bundled with the Claude Code release above.
  sdkVersion: "0.128.0",
  baseBetas: Object.freeze([
    ...REQUIRED_BETAS,
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    EFFORT_BETA,
    "extended-cache-ttl-2025-04-11",
  ]),
})

function supportsEffort(modelId: string): boolean {
  const canonical = modelId
    .toLowerCase()
    .replace(/\[1m\]$/, "")
    .replace(/-\d{8}$/, "")
  return !canonical.startsWith("claude-3-") && !NO_EFFORT_MODELS.has(canonical)
}

/**
 * Beta flags for a model: the configured base set (or `ANTHROPIC_BETA_FLAGS`)
 * merged with any flags the caller already sent (`incoming`, the raw
 * `anthropic-beta` header) and the betas subscription auth requires, minus
 * the effort beta for models that do not support it. The exclusion runs
 * after the merge so an inbound header cannot reintroduce the flag.
 */
export function getModelBetas(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
  incoming = "",
): string[] {
  const override = splitBetas(env.ANTHROPIC_BETA_FLAGS ?? "")
  // An override of only separators parses to nothing; that is a malformed
  // value, not a request to send an empty beta set.
  const configured = override.length > 0 ? override : config.baseBetas
  const betas = new Set([
    ...REQUIRED_BETAS,
    ...configured,
    ...splitBetas(incoming),
  ])
  if (!supportsEffort(modelId)) betas.delete(EFFORT_BETA)
  return [...betas]
}

function splitBetas(raw: string): string[] {
  return raw
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
}
