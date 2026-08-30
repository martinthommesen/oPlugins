import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { config, getModelBetas } from "./model-config.ts"

describe("model beta configuration", () => {
  it("returns the required Claude Code flags", () => {
    assert.deepEqual(getModelBetas("claude-sonnet-4-5", {}), config.baseBetas)
  })

  it("applies model-specific effort flags", () => {
    assert.ok(
      getModelBetas("claude-opus-4-6", {}).includes("effort-2025-11-24"),
    )
    assert.ok(
      !getModelBetas("claude-sonnet-4-6", {
        ANTHROPIC_BETA_FLAGS: "oauth-2025-04-20,effort-2025-11-24",
      }).includes("effort-2025-11-24"),
    )
    assert.ok(
      !getModelBetas("claude-haiku-4-5", {
        ANTHROPIC_BETA_FLAGS: "oauth-2025-04-20,effort-2025-11-24",
      }).includes("effort-2025-11-24"),
    )
  })

  it("uses a deduplicated environment override", () => {
    assert.deepEqual(
      getModelBetas("claude-sonnet-4-5", {
        ANTHROPIC_BETA_FLAGS: "custom-beta, custom-beta, oauth-2025-04-20",
      }),
      ["custom-beta", "oauth-2025-04-20"],
    )
  })
})
