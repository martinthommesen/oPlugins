import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { config, getModelBetas } from "./model-config.ts"

describe("model beta configuration", () => {
  it("returns the required Claude Code flags", () => {
    assert.deepEqual(getModelBetas("claude-fable-5-1", {}), config.baseBetas)
  })

  it("sends effort for the models the CLI enables it on", () => {
    for (const model of [
      "claude-fable-5-1",
      "claude-fable-5",
      "claude-mythos-5",
      "claude-opus-4-6",
      "claude-opus-4-7",
      "claude-opus-4-8",
      "claude-opus-5",
      "claude-sonnet-5",
      "claude-sonnet-4-6",
    ]) {
      assert.ok(
        getModelBetas(model, {}).includes("effort-2025-11-24"),
        `${model} should send effort`,
      )
    }
  })

  it("strips effort for the models the CLI disables it on", () => {
    for (const model of [
      "claude-3-5-sonnet-20241022",
      "claude-haiku-3-5",
      "claude-haiku-4-5",
      "claude-opus-4-0",
      "claude-opus-4-1",
      "claude-sonnet-4-0",
      "claude-sonnet-4-5",
    ]) {
      assert.ok(
        !getModelBetas(model, {}).includes("effort-2025-11-24"),
        `${model} should not send effort`,
      )
      assert.ok(
        !getModelBetas(model, {
          ANTHROPIC_BETA_FLAGS: "oauth-2025-04-20,effort-2025-11-24",
        }).includes("effort-2025-11-24"),
        `${model} should not send effort from ANTHROPIC_BETA_FLAGS either`,
      )
    }
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
