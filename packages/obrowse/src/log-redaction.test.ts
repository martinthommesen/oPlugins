import { describe, expect, it } from "@effect/vitest"
import redact from "./log-redaction.ts"

const ITEM_COUNT = 42,
  STATUS_OK = 200

describe("log redaction of secret fields", () => {
  it("fully redacts secrets by field name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      redact({
        authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.abc123",
        cookie: "session=abc123",
        password: "hunter2",
        "set-cookie": "session=def456; HttpOnly",
      }),
    ).toStrictEqual({
      authorization: "REDACTED",
      cookie: "REDACTED",
      password: "REDACTED",
      "set-cookie": "REDACTED",
    })
  })

  it(
    "redacts short and empty secrets without crashing",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(redact({ accessToken: "short", token: "" })).toStrictEqual({
        accessToken: "REDACTED",
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
})

describe("log redaction of structures", () => {
  it(
    "redacts nested and arrayed secrets, not just top-level ones",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        redact({
          request: { cookie: "session=abc123", url: "https://example.com" },
          values: ["eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.payload", "plain"],
        }),
      ).toStrictEqual({
        request: { cookie: "REDACTED", url: "https://example.com" },
        values: ["eyJhbGci...REDACTED", "plain"],
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
                    blob: { password: "another-secret" },
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
    },
  )
})

describe("log redaction of ordinary fields", () => {
  it("preserves non-sensitive fields", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const fields = {
      method: "GET",
      status: STATUS_OK,
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
