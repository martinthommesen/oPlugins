import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { computeVersionSuffix, buildBillingHeaderValue } from "./signing.ts"

describe("signing", () => {
  describe("computeVersionSuffix", () => {
    it("matches test vector: 'hey' with v2.1.37 gives 0d9", () => {
      assert.equal(computeVersionSuffix("hey", "2.1.37"), "0d9")
    })

    it("matches test vector: 'hey' with v2.1.90 gives b39", () => {
      assert.equal(computeVersionSuffix("hey", "2.1.90"), "b39")
    })

    it("pads short messages with '0' for OOB indices", () => {
      // "hey" is length 3, so indices 4, 7 and 20 all pad to "0", the same
      // sample any other sub-index-4 message produces.
      assert.equal(
        computeVersionSuffix("hey", "2.1.37"),
        computeVersionSuffix("abc", "2.1.37"),
      )
      assert.notEqual(
        computeVersionSuffix("hey", "2.1.37"),
        computeVersionSuffix("heyxxxxx", "2.1.37"),
      )
    })

    it("samples correct character indices from long message", () => {
      // "Hello, how are you doing today?"
      //  01234567890123456789012345678901
      //      ^  ^            ^
      //  [4]='o' [7]='h' [20]='o'
      assert.equal(
        computeVersionSuffix("Hello, how are you doing today?", "2.1.90"),
        "494",
      )
    })

    it("handles empty string (all indices pad to '0')", () => {
      assert.equal(computeVersionSuffix("", "2.1.90"), "b39")
    })
  })

  describe("buildBillingHeaderValue", () => {
    it("produces correct header for the first user text", () => {
      const result = buildBillingHeaderValue("hey", "2.1.295", "sdk-cli")
      assert.ok(
        result.startsWith("x-anthropic-billing-header: cc_version=2.1.295."),
      )
      assert.ok(result.includes("cc_entrypoint=sdk-cli"))
      assert.ok(result.includes("cch=00000;"))
    })

    it("handles missing user message with the CLI's fixed cch placeholder", () => {
      const result = buildBillingHeaderValue("", "2.1.295", "sdk-cli")
      assert.ok(result.includes("cch=00000;"))
    })

    it("uses provided entrypoint", () => {
      const result = buildBillingHeaderValue("hey", "2.1.112", "cli")
      assert.ok(result.includes("cc_entrypoint=cli;"))
    })
  })
})
