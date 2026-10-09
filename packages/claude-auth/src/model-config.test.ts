import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { config, getModelBetas } from "./model-config.ts"

const EFFORT = "effort-2025-11-24"

/** The base set, written out so a change to the list has to change a test. */
const BASE_BETAS = [
  "claude-code-20250219",
  "oauth-2025-04-20",
  "interleaved-thinking-2025-05-14",
  "prompt-caching-scope-2026-01-05",
  "context-management-2025-06-27",
  "advisor-tool-2026-03-01",
  "thinking-token-count-2026-05-13",
  EFFORT,
  "extended-cache-ttl-2025-04-11",
]

describe("model beta configuration", () => {
  it("returns the required Claude Code flags", () => {
    assert.deepEqual(getModelBetas("claude-fable-5-1", {}), BASE_BETAS)
  })

  it("sends effort for the models the CLI enables it on", () => {
    for (const model of [
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-mythos-5-1",
      "claude-haiku-5-5",
      "claude-opus-4-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-opus-5-5",
      "claude-sonnet-5",
      "claude-sonnet-5-5",
      "claude-sonnet-4-6",
      "claude-sonnet-4-6-20260217",
      "claude-sonnet-4-50",
      "claude-opus-4-10",
      "claude-future-6",
    ]) {
      assert.ok(
        getModelBetas(model, {}).includes(EFFORT),
        `${model} should send effort`,
      )
    }
  })

  it("strips effort for the ids the CLI's predicate denies", () => {
    for (const model of [
      "claude-3-5-sonnet-20241022",
      "claude-3-5-haiku-20241022",
      "claude-haiku-4-5",
      "claude-haiku-4-5-20251001",
      "claude-opus-4-0",
      "claude-opus-4-20250514",
      "claude-opus-4-1",
      "claude-opus-4-1-20250805",
      "claude-sonnet-4-0",
      "claude-sonnet-4-20250514",
      "claude-sonnet-4-5",
      "claude-sonnet-4-5-20250929",
      "CLAUDE-SONNET-4-5[1m]",
    ]) {
      assert.ok(
        !getModelBetas(model, {}).includes(EFFORT),
        `${model} should not send effort`,
      )
      assert.ok(
        !getModelBetas(model, {
          ANTHROPIC_BETA_FLAGS: `oauth-2025-04-20,${EFFORT}`,
        }).includes(EFFORT),
        `${model} should not send effort from ANTHROPIC_BETA_FLAGS either`,
      )
      assert.ok(
        !getModelBetas(model, {}, EFFORT).includes(EFFORT),
        `${model} should not send effort from an inbound header either`,
      )
    }
  })

  it("merges inbound flags after the base set", () => {
    assert.deepEqual(getModelBetas("claude-opus-5", {}, " custom-beta,, "), [
      ...BASE_BETAS,
      "custom-beta",
    ])
  })

  it("falls back to the base set when the environment override is empty", () => {
    assert.deepEqual(
      getModelBetas("claude-opus-5", { ANTHROPIC_BETA_FLAGS: "" }),
      BASE_BETAS,
    )
    assert.deepEqual(
      getModelBetas("claude-opus-5", { ANTHROPIC_BETA_FLAGS: "  " }),
      BASE_BETAS,
    )
  })

  it("uses a deduplicated environment override", () => {
    assert.deepEqual(
      getModelBetas("claude-sonnet-4-5", {
        ANTHROPIC_BETA_FLAGS: "custom-beta, custom-beta, oauth-2025-04-20",
      }),
      ["claude-code-20250219", "oauth-2025-04-20", "custom-beta"],
    )
  })

  it("keeps the betas subscription auth needs when an override omits them", () => {
    const betas = getModelBetas("claude-opus-5", {
      ANTHROPIC_BETA_FLAGS: "context-1m-2025-08-07",
    })
    assert.ok(betas.includes("oauth-2025-04-20"))
    assert.ok(betas.includes("claude-code-20250219"))
    assert.ok(betas.includes("context-1m-2025-08-07"))
  })

  it("cannot be changed by an importer", () => {
    assert.throws(() => {
      ;(config.baseBetas as string[]).push("injected")
    }, TypeError)
    assert.equal(getModelBetas("claude-opus-5", {}).includes("injected"), false)
  })

  it("falls back to the base set for a separator-only override", () => {
    for (const value of [",", " , , "]) {
      assert.deepEqual(
        getModelBetas("claude-opus-5", { ANTHROPIC_BETA_FLAGS: value }),
        BASE_BETAS,
        `"${value}" must not produce an empty beta set`,
      )
    }
  })
})
