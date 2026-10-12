import { Array as Arr, Option } from "effect"

/** OpenCode's token usage record. `input` excludes cache reads and writes. */
interface TokenUsage {
  readonly input: number
  readonly output: number
  readonly reasoning: number
  readonly cache: { readonly read: number; readonly write: number }
}

/** How some prompt tokens split between cache reads, cache writes, and input. */
interface CacheStats {
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

/** The parts of an OpenCode message that cache statistics read. */
interface MessageLike {
  readonly type: string
  readonly tokens?: TokenUsage
}

const COMPACT = new Intl.NumberFormat("en-US", {
    maximumFractionDigits: 1,
    notation: "compact",
  }),
  NO_TOKENS = 0,
  PERCENT = 100,
  PERCENT_DIGITS = 1,
  WHOLE = 1,
  /* A token count, with negative and non-finite counts as zero. */
  asCount = (value: number): number => {
    if (!Number.isFinite(value)) {
      return NO_TOKENS
    }

    return Math.max(NO_TOKENS, value)
  },
  /* The statistics for these counts of prompt tokens. */
  buildStats = (
    counts: Pick<CacheStats, "read" | "uncached" | "write">,
  ): CacheStats => {
    const prompt = counts.read + counts.write + counts.uncached,
      share = counts.read / prompt

    return {
      hitRate: share,
      missRate: WHOLE - share,
      prompt,
      read: counts.read,
      uncached: counts.uncached,
      write: counts.write,
    }
  },
  /* Cache statistics for a usage record, or none when it has no prompt. */
  cacheStats = (tokens?: TokenUsage): Option.Option<CacheStats> =>
    Option.fromNullishOr(tokens).pipe(
      Option.map((usage: TokenUsage) =>
        buildStats({
          read: asCount(usage.cache.read),
          uncached: asCount(usage.input),
          write: asCount(usage.cache.write),
        }),
      ),
      Option.filter((stats: CacheStats) => stats.prompt !== NO_TOKENS),
    ),
  compactTokens = (value: number): string => COMPACT.format(value),
  formatBreakdown = (stats: CacheStats): string =>
    `${compactTokens(stats.read)} read · ${compactTokens(stats.write)} write · ${compactTokens(stats.uncached)} uncached`,
  formatPercent = (rate: number): string =>
    `${(rate * PERCENT).toFixed(PERCENT_DIGITS)}%`,
  formatRates = (stats: CacheStats): string =>
    `${formatPercent(stats.hitRate)} hit · ${formatPercent(stats.missRate)} miss`,
  /* Cache statistics for the newest assistant message that reported usage. */
  lastRequestStats = (
    messages?: readonly MessageLike[],
  ): Option.Option<CacheStats> =>
    Option.fromNullishOr(messages).pipe(
      Option.flatMap(
        Arr.findLast((message: MessageLike) => {
          if (message.type !== "assistant") {
            return Option.none()
          }

          return cacheStats(message.tokens)
        }),
      ),
    )

/** Prompt cache statistics from OpenCode's token usage, and their wording. */
export default Object.freeze({
  cacheStats,
  formatBreakdown,
  formatPercent,
  formatRates,
  formatTokens: compactTokens,
  lastRequestStats,
})
