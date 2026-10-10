import { describe, expect, it } from "@effect/vitest"
import redact from "./log-redaction.ts"

const EXPIRY = 1_742_860_800_000,
  ITEM_COUNT = 42

describe("log redaction of secret fields", () => {
  it("fully redacts tokens and keys by field name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      redact({
        accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
        refreshToken: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4",
        "x-api-key": "sk-ant-api03-abc123def456",
      }),
    ).toStrictEqual({
      accessToken: "REDACTED",
      refreshToken: "REDACTED",
      "x-api-key": "REDACTED",
    })
  })

  it("redacts the Keychain account name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(redact({ account: "someone@example.com" })).toStrictEqual({
      account: "REDACTED",
    })
  })

  it(
    "redacts short and empty tokens without crashing",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(redact({ accessToken: "short", refreshToken: "" })).toStrictEqual({
        accessToken: "REDACTED",
        refreshToken: "REDACTED",
      })
    },
  )
})

describe("log redaction of token-shaped values", () => {
  it("catches JWT-pattern strings in arbitrary keys", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      redact({
        someToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
      }),
    ).toStrictEqual({ someToken: "eyJhbGci...REDACTED" })
  })

  it(
    "catches the Anthropic token format the plugin actually handles",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        redact({
          bearer: "sk-ant-oat01-abcdefghijklmnop",
          other: "sk-ant-api03-zyxwvutsrq",
        }),
      ).toStrictEqual({
        bearer: "sk-ant-o...REDACTED",
        other: "sk-ant-a...REDACTED",
      })
    },
  )
})

describe("log redaction of structures", () => {
  it(
    "redacts nested and arrayed secrets, not just top-level ones",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        redact({
          credential: { accessToken: "sk-ant-oat01-secret", source: "file" },
          headers: ["sk-ant-oat01-secret", "plain"],
        }),
      ).toStrictEqual({
        credential: { accessToken: "REDACTED", source: "file" },
        headers: ["sk-ant-o...REDACTED", "plain"],
      })
    },
  )

  it(
    "never logs a secret nested past the depth limit",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const output = JSON.stringify(
        redact({
          level: {
            level: {
              level: {
                level: {
                  level: {
                    accessToken: "plain-secret-value",
                    blob: { refreshToken: "another-secret" },
                  },
                },
              },
            },
          },
        }),
      )

      expect(output).not.toContain("plain-secret-value")
      expect(output).not.toContain("another-secret")
    },
  )
})

describe("log redaction of ordinary fields", () => {
  it("preserves non-sensitive fields", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const fields = {
      expiresAt: EXPIRY,
      modelId: "claude-opus-4-6",
      source: "Claude Code-credentials",
      subscriptionType: "max",
    }

    expect(redact(fields)).toStrictEqual(fields)
  })

  it("passes through non-string values unchanged", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const fields = { count: ITEM_COUNT, items: ["a", "b"], success: true }

    expect(redact(fields)).toStrictEqual(fields)
  })
})
