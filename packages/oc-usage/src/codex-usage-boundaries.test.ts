import { Option, Redacted, Result } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Base64Url } from "effect/encoding"
import codexUsage from "./codex-usage.ts"

const ESCAPE_CODE = 27,
  ESCAPE_TEXT = String.fromCodePoint(ESCAPE_CODE),
  FIFTY_SECONDS = 50,
  THIRTY_SECONDS = 30,
  headersFor = (
    claims: string,
    accountId: Option.Option<string> = Option.none(),
  ): Result.Result<string | undefined, string> => {
    const token = [
      Base64Url.encode('{"alg":"none"}'),
      Base64Url.encode(claims),
      "signature",
    ].join(".")

    return codexUsage
      .prepare({ accountId, token: Redacted.make(token) })
      .pipe(Result.map((headers) => headers["chatgpt-account-id"]))
  },
  labelsFor = (seconds: number): Option.Option<readonly string[]> =>
    codexUsage
      .read(
        JSON.stringify({
          plan_type: "plus",
          rate_limit: { primary_window: { limit_window_seconds: seconds } },
        }),
      )
      .pipe(
        Option.map((reading) => reading.windows.map((window) => window.label)),
      )

describe("short limit windows", () => {
  it(
    "does not round a real window into a zero-minute limit",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(labelsFor(THIRTY_SECONDS)).toStrictEqual(
        Option.some(["30-second"]),
      )
      expect(labelsFor(FIFTY_SECONDS)).toStrictEqual(Option.some(["50-second"]))
    },
  )
})

describe.each([
  '{"chatgpt_account_id":"acct-1","https://api.openai.com/auth":{"chatgpt_account_id":17}}',
  '{"chatgpt_account_id":17,"https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"}}',
  '{"chatgpt_account_id":"","https://api.openai.com/auth":{"chatgpt_account_id":"acct-1"}}',
])("independent account claims in %j", (claims) => {
  it(
    "keeps a usable account even when another optional claim is malformed",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(headersFor(claims)).toStrictEqual(Result.succeed("acct-1"))
    },
  )
})

describe("unusable metadata accounts", () => {
  it(
    "falls back instead of sending whitespace or control characters as an account header",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        headersFor('{"chatgpt_account_id":"acct-1"}', Option.some(" \t")),
      ).toStrictEqual(Result.succeed("acct-1"))
      expect(
        headersFor('{"chatgpt_account_id":"acct-1"}', Option.some(ESCAPE_TEXT)),
      ).toStrictEqual(Result.succeed("acct-1"))
    },
  )
})
