import { describe, expect, it } from "@effect/vitest"
import redact from "./log-redaction.ts"

const EXPIRY = 1_742_860_800_000,
  ITEM_COUNT = 42,
  STATUS_OK = 200

describe("log redaction of secret fields", () => {
  it("fully redacts secrets by field name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      redact({
        accessToken: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
        authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
        cookie: "session=abc123",
        password: "hunter2",
        refreshToken: "dGhpcyBpcyBhIHJlZnJlc2ggdG9rZW4",
        "set-cookie": "session=def456; HttpOnly",
        "x-api-key": "sk-ant-api03-abc123def456",
      }),
    ).toStrictEqual({
      accessToken: "REDACTED",
      authorization: "REDACTED",
      cookie: "REDACTED",
      password: "REDACTED",
      refreshToken: "REDACTED",
      "set-cookie": "REDACTED",
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
    "redacts short and empty secrets without crashing",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        redact({ accessToken: "short", refreshToken: "", token: "" }),
      ).toStrictEqual({
        accessToken: "REDACTED",
        refreshToken: "REDACTED",
        token: "REDACTED",
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
    "catches the Anthropic token format oc-auth handles",
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

describe("log redaction of tokens inside text", () => {
  it(
    "redacts a token an error message quotes, keeping the rest",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        redact({
          error:
            "refresh failed: Bearer sk-ant-ort01-abcdefghijklmnop rejected, id eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature",
        }),
      ).toStrictEqual({
        error:
          "refresh failed: Bearer sk-ant-o...REDACTED rejected, id eyJhbGci...REDACTED",
      })
    },
  )

  it(
    "redacts all of a string that starts with a JWT",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        redact({
          blob: "eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9+c2VjcmV0/dGFpbA== tail",
        }),
      ).toStrictEqual({ blob: "eyJhbGci...REDACTED" })
    },
  )
})

describe("log redaction of structures", () => {
  it(
    "redacts secrets in nested objects and in arrays",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        redact({
          credential: { accessToken: "sk-ant-oat01-secret", source: "file" },
          headers: ["sk-ant-oat01-secret", "plain"],
          request: { cookie: "session=abc123", url: "https://example.com" },
          values: ["eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload", "plain"],
        }),
      ).toStrictEqual({
        credential: { accessToken: "REDACTED", source: "file" },
        headers: ["sk-ant-o...REDACTED", "plain"],
        request: { cookie: "REDACTED", url: "https://example.com" },
        values: ["eyJhbGci...REDACTED", "plain"],
      })
    },
  )
})

describe("log redaction of deep structures", () => {
  it("drops a secret nested past the depth limit", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const output = JSON.stringify(
      redact({
        level: {
          level: {
            level: {
              level: {
                level: {
                  accessToken: "plain-secret-value",
                  blob: {
                    password: "another-secret",
                    refreshToken: "another-secret",
                  },
                  token: "plain-secret-value",
                },
              },
            },
          },
        },
      }),
    )

    expect(output).not.toContain("plain-secret-value")
    expect(output).not.toContain("another-secret")
  })
})

describe("log redaction of ordinary fields", () => {
  it("keeps fields that hold no secret", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const fields = {
      expiresAt: EXPIRY,
      method: "GET",
      modelId: "claude-opus-4-6",
      source: "Claude Code-credentials",
      status: STATUS_OK,
      subscriptionType: "max",
      tabTitle: "Example Domain",
      url: "https://example.com/",
    }

    expect(redact(fields)).toStrictEqual(fields)
  })

  it("passes through non-string values unchanged", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const fields = { count: ITEM_COUNT, items: ["a", "b"], success: true }

    expect(redact(fields)).toStrictEqual(fields)
  })
})
