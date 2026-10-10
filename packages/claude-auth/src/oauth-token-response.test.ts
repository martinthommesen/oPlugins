import { Effect, Option } from "effect"
import { describe, expect, it } from "@effect/vitest"
import oauthResponse from "./oauth-token-response.ts"

const ABSOLUTE_OFFSET_MS = 1234,
  NOW = 1_767_225_600_000,
  RELATIVE_MS = 10_000,
  THREE_ASSERTIONS = 3,
  TWO_ASSERTIONS = 2,
  /* The credentials `raw` carries at `NOW`, the current refresh token being `current`. */
  parse = (
    raw: string,
    current: string,
  ): ReturnType<typeof oauthResponse.credentials> =>
    oauthResponse.credentials(raw, current, NOW)

describe("token response expiry", () => {
  it.effect(
    "parses absolute and relative expiries without losing refresh tokens",
    () =>
      Effect.sync(() => {
        expect.assertions(TWO_ASSERTIONS)

        expect(
          parse(
            JSON.stringify({
              access_token: "a",
              expires_at: NOW + ABSOLUTE_OFFSET_MS,
            }),
            "existing-refresh",
          ),
        ).toStrictEqual(
          Option.some({
            accessToken: "a",
            expiresAt: NOW + ABSOLUTE_OFFSET_MS,
            refreshToken: "existing-refresh",
          }),
        )
        expect(
          parse(
            JSON.stringify({ access_token: "a", expires_in: 10 }),
            "r",
          ).pipe(Option.map((credentials) => credentials.expiresAt)),
        ).toStrictEqual(Option.some(NOW + RELATIVE_MS))
      }),
  )
})

describe("unusable token responses", () => {
  it.effect("rejects a response without a usable expiry", () =>
    Effect.sync(() => {
      expect.assertions(TWO_ASSERTIONS)

      expect(parse(JSON.stringify({ access_token: "a" }), "r")).toStrictEqual(
        Option.none(),
      )
      expect(
        parse('{"access_token":"a","expires_in":1e309}', "r"),
      ).toStrictEqual(Option.none())
    }),
  )

  it.effect(
    "rejects a body that is not an object or has a blank refresh token",
    () =>
      Effect.sync(() => {
        expect.assertions(THREE_ASSERTIONS)

        expect(parse("null", "r")).toStrictEqual(Option.none())
        expect(
          parse(
            JSON.stringify({
              access_token: "a",
              expires_in: 10,
              refresh_token: "   ",
            }),
            "r",
          ),
        ).toStrictEqual(Option.none())
        expect(parse("not json", "r")).toStrictEqual(Option.none())
      }),
  )
})
