export interface ModelOverride {
  exclude?: string[]
  add?: string[]
}

export interface ModelConfig {
  ccVersion: string
  baseBetas: string[]
  modelOverrides: Record<string, ModelOverride>
}

export const config: ModelConfig = {
  ccVersion: "2.1.217",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "extended-cache-ttl-2025-04-11",
  ],
  // NOTE: getModelOverride is first-match-wins. The "sonnet" key must stay
  // ahead of "4-6"/"4-7": it shields claude-sonnet-4-6 from the "4-6"
  // effort add-override, and its exclude strips effort if a user supplies
  // it via ANTHROPIC_BETA_FLAGS. Do not remove it as inert — the split is
  // pinned by the model-specific effort test in model-config.test.ts.
  modelOverrides: {
    sonnet: {
      exclude: ["effort-2025-11-24"],
    },
    haiku: {
      exclude: ["effort-2025-11-24"],
    },
    "4-6": {
      add: ["effort-2025-11-24"],
    },
    "4-7": {
      add: ["effort-2025-11-24"],
    },
  },
}

/**
 * Find the override entry matching a model ID.
 * Keys are matched via includes() against the lowercased model ID.
 *
 * First-match-wins: if multiple keys match, only the first (by insertion
 * order) is returned. List more specific keys before broader ones
 * (e.g. "opus-4-6" before "opus") so they take priority.
 */
export function getModelOverride(modelId: string): ModelOverride | null {
  const lower = modelId.toLowerCase()
  for (const [pattern, override] of Object.entries(config.modelOverrides)) {
    if (lower.includes(pattern)) return override
  }
  return null
}

export function getModelBetas(
  modelId: string,
  env: Record<string, string | undefined> = process.env,
): string[] {
  let betas = (env.ANTHROPIC_BETA_FLAGS ?? config.baseBetas.join(","))
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)

  const override = getModelOverride(modelId)
  if (override?.exclude) {
    betas = betas.filter((beta) => !override.exclude!.includes(beta))
  }
  for (const beta of override?.add ?? []) {
    if (!betas.includes(beta)) betas.push(beta)
  }
  return [...new Set(betas)]
}
