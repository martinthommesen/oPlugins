import { describe, expect, it } from "@effect/vitest"
import host from "./plugin-host.test-support.ts"
import hostFailure from "./host-failure.ts"

/** The tags of host failures, and the category each names. */
const NAMED = [
    ["ConflictError", "conflict"],
    ["SessionBusyError", "conflict"],
    ["InvalidRequestError", "invalid_request"],
    ["AgentNotFoundError", "not_found"],
    ["LocationNotFoundError", "not_found"],
    ["MessageNotFoundError", "not_found"],
    ["ProviderNotFoundError", "not_found"],
    ["SessionNotFoundError", "not_found"],
    ["ForbiddenError", "unauthorized"],
    ["UnauthorizedError", "unauthorized"],
    ["ServiceUnavailableError", "unavailable"],
  ] as const,
  /** Host failures that name no category this plugin knows. */
  UNNAMED = [
    host.hostFailure("UnknownError"),
    host.hostFailure("session not found"),
    { message: "SessionNotFoundError: session not found" },
    "session not found",
    "ServiceUnavailableError",
  ] as const

describe("a host failure's category", () => {
  it("comes from the failure's structured tag", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      NAMED.map(([tag]) => hostFailure.categorize(host.hostFailure(tag))),
    ).toStrictEqual(NAMED.map(([, category]) => category))
  })

  it(
    "is unknown when no tag names one, whatever the text says",
    {
      timeout: 5000,
    },
    () => {
      expect.hasAssertions()
      expect(
        UNNAMED.map((failure) => hostFailure.categorize(failure)),
      ).toStrictEqual(UNNAMED.map(() => "unknown"))
    },
  )
})
