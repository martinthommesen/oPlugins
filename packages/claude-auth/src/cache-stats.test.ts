import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  cacheStats,
  formatBreakdown,
  formatPercent,
  formatRates,
  formatTokens,
  lastRequestStats,
  type TokenUsage,
} from "./cache-stats.ts"

function usage(input: number, read: number, write: number): TokenUsage {
  return { input, output: 50, reasoning: 10, cache: { read, write } }
}

describe("cacheStats", () => {
  it("counts cache reads against every prompt token", () => {
    const stats = cacheStats(usage(100, 800, 100))
    assert.deepEqual(stats, {
      read: 800,
      write: 100,
      uncached: 100,
      prompt: 1000,
      hitRate: 0.8,
      missRate: 0.19999999999999996,
    })
  })

  it("ignores output and reasoning tokens", () => {
    const stats = cacheStats({
      input: 10,
      output: 9999,
      reasoning: 9999,
      cache: { read: 0, write: 0 },
    })
    assert.equal(stats?.prompt, 10)
    assert.equal(stats?.hitRate, 0)
    assert.equal(stats?.missRate, 1)
  })

  it("reports nothing without prompt tokens", () => {
    assert.equal(cacheStats(undefined), undefined)
    assert.equal(cacheStats(usage(0, 0, 0)), undefined)
  })

  it("treats negative and non-finite counts as zero", () => {
    const stats = cacheStats(usage(Number.NaN, 50, -5))
    assert.equal(stats?.prompt, 50)
    assert.equal(stats?.hitRate, 1)
  })
})

describe("lastRequestStats", () => {
  it("uses the newest assistant message that reported usage", () => {
    const stats = lastRequestStats([
      { type: "assistant", tokens: usage(100, 0, 900) },
      { type: "user" },
      { type: "assistant", tokens: usage(10, 990, 0) },
      { type: "assistant" },
      { type: "compaction", tokens: usage(500, 0, 0) },
    ])
    assert.equal(stats?.hitRate, 0.99)
  })

  it("reports nothing before the first response", () => {
    assert.equal(lastRequestStats(undefined), undefined)
    assert.equal(lastRequestStats([{ type: "user" }]), undefined)
  })
})

describe("formatting", () => {
  it("formats rates, token counts, and the breakdown", () => {
    const stats = cacheStats(usage(30_000, 1_200_000, 45_200))!
    assert.equal(formatTokens(950), "950")
    assert.equal(formatTokens(45_200), "45.2K")
    assert.equal(formatTokens(1_234_567), "1.2M")
    assert.equal(formatPercent(0.8734), "87.3%")
    assert.equal(formatRates(stats), "94.1% hit · 5.9% miss")
    assert.equal(
      formatBreakdown(stats),
      "1.2M read · 45.2K write · 30K uncached",
    )
  })
})
