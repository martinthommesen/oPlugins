import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import pluginResponses from "./plugin-responses.ts"
import support from "./request-transforms.test-support.ts"

const FOUR_ASSERTIONS = 4,
  LONG_WAIT_MS = 3_600_000,
  NO_WAIT_MS = 0,
  PARTIAL_SECOND_MS = 1500,
  THREE_ASSERTIONS = 3,
  TOO_MANY_REQUESTS = 429,
  UNAUTHORIZED = 401

describe("plugin rate-limit response", () => {
  it.effect("is a retryable 429 in the API's error format", () =>
    Effect.gen(function* run() {
      expect.assertions(FOUR_ASSERTIONS)

      const response = pluginResponses.retryableRefresh(PARTIAL_SECOND_MS)

      expect(response.status).toBe(TOO_MANY_REQUESTS)
      expect(response.headers.get("x-should-retry")).toBe("true")
      expect(response.headers.get("retry-after")).toBe("2")
      expect(yield* support.bodyText(response)).toBe(
        '{"type":"error","error":{"type":"rate_limit_error","message":"Claude token refresh is temporarily unavailable."}}',
      )
    }),
  )

  it.effect("waits at least one second and at most sixty", () =>
    Effect.sync(() => {
      expect.assertions(THREE_ASSERTIONS)
      expect(
        pluginResponses.retryableRefresh(NO_WAIT_MS).headers.get("retry-after"),
      ).toBe("1")
      expect(
        pluginResponses
          .retryableRefresh(LONG_WAIT_MS)
          .headers.get("retry-after"),
      ).toBe("60")
      expect(
        pluginResponses
          .retryableRefresh(PARTIAL_SECOND_MS)
          .headers.get("content-type"),
      ).toBe("application/json")
    }),
  )
})

describe("plugin authentication response", () => {
  it.effect("is a 401 carrying the message in the API's error format", () =>
    Effect.gen(function* run() {
      expect.assertions(THREE_ASSERTIONS)

      const response = pluginResponses.authenticationError("Run `claude`.")

      expect(response.status).toBe(UNAUTHORIZED)
      expect(response.headers.get("content-type")).toBe("application/json")
      expect(yield* support.bodyText(response)).toBe(
        '{"type":"error","error":{"type":"authentication_error","message":"Run `claude`."}}',
      )
    }),
  )
})
