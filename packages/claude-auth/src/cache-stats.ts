/** OpenCode's token usage record. `input` excludes cache reads and writes. */
export interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

export interface CacheStats {
  /** Prompt tokens served from the cache. */
  readonly read: number
  /** Prompt tokens written to the cache. */
  readonly write: number
  /** Prompt tokens neither read from nor written to the cache. */
  readonly uncached: number
  /** Every prompt token: `read + write + uncached`. */
  readonly prompt: number
  /** Share of prompt tokens served from the cache, from 0 to 1. */
  readonly hitRate: number
  /** Share of prompt tokens not served from the cache, from 0 to 1. */
  readonly missRate: number
}

interface MessageLike {
  readonly type: string
  readonly tokens?: TokenUsage
}

const count = (value: number | undefined): number =>
  Number.isFinite(value) ? Math.max(0, value as number) : 0

/** Cache statistics for a usage record, or undefined when it has no prompt. */
export function cacheStats(
  tokens: TokenUsage | undefined,
): CacheStats | undefined {
  if (!tokens) return undefined
  const read = count(tokens.cache?.read)
  const write = count(tokens.cache?.write)
  const uncached = count(tokens.input)
  const prompt = read + write + uncached
  if (prompt === 0) return undefined
  const hitRate = read / prompt
  return { read, write, uncached, prompt, hitRate, missRate: 1 - hitRate }
}

/** Cache statistics for the newest assistant message that reported usage. */
export function lastRequestStats(
  messages: readonly MessageLike[] | undefined,
): CacheStats | undefined {
  if (!messages) return undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message.type !== "assistant") continue
    const stats = cacheStats(message.tokens)
    if (stats) return stats
  }
  return undefined
}

const compact = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
})

export function formatTokens(value: number): string {
  return compact.format(value)
}

export function formatPercent(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

export function formatRates(stats: CacheStats): string {
  return `${formatPercent(stats.hitRate)} hit · ${formatPercent(stats.missRate)} miss`
}

export function formatBreakdown(stats: CacheStats): string {
  return `${formatTokens(stats.read)} read · ${formatTokens(stats.write)} write · ${formatTokens(stats.uncached)} uncached`
}
