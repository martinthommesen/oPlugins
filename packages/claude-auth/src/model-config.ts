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
  ccVersion: "2.1.266",
  baseBetas: [
    "claude-code-20250219",
    "oauth-2025-04-20",
    "interleaved-thinking-2025-05-14",
    "prompt-caching-scope-2026-01-05",
    "context-management-2025-06-27",
    "advisor-tool-2026-03-01",
    "thinking-token-count-2026-05-13",
    "effort-2025-11-24",
    "extended-cache-ttl-2025-04-11",
  ],
  // NOTE: effort is a base flag that a denylist strips, not an allowlist that
  // names each model. The CLI enables effort for every model except the
  // families below, so an allowlist silently omits the flag for every model
  // released after the last refresh. Captured from Claude Code 2.1.266
  // traffic: fable-5(-1), mythos-5, opus-4-6/4-7/4-8, opus-5, sonnet-5, and
  // sonnet-4-6 all send it; sonnet-4-5 and haiku-4-5 do not.
  //
  // Keys are matched with includes(), so they must stay specific: a bare
  // "haiku" or "sonnet" would strip effort from future models in those
  // families and reintroduce the same staleness.
  modelOverrides: {
    "claude-3": {
      exclude: ["effort-2025-11-24"],
    },
    "haiku-3-5": {
      exclude: ["effort-2025-11-24"],
    },
    "haiku-4-5": {
      exclude: ["effort-2025-11-24"],
    },
    "opus-4-0": {
      exclude: ["effort-2025-11-24"],
    },
    "opus-4-1": {
      exclude: ["effort-2025-11-24"],
    },
    "sonnet-4-0": {
      exclude: ["effort-2025-11-24"],
    },
    "sonnet-4-5": {
      exclude: ["effort-2025-11-24"],
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
