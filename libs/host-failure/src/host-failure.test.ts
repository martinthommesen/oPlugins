import { describe, expect, it } from "@effect/vitest"
import { Schema } from "effect"
import failures from "./host-failure.test-support.ts"
import hostFailure from "./host-failure.ts"

/*
 * Failures the plugin context's calls raise in OpenCode 2.0.27, each with
 * the tag and fields its `Schema.TaggedError` class declares in
 * `packages/core/src`, and the category each names.
 */
const NAMED = [
    [
      Schema.TaggedStruct("Session.SyntheticConflictError", {
        inputID: Schema.String,
        sessionID: Schema.String,
      }).make({ inputID: "msg_1", sessionID: "ses_1" }),
      "conflict",
    ],
    [failures.provider("InvalidRequest"), "invalid_request"],
    [
      Schema.TaggedStruct("FileSystem.DirectoryNotFoundError", {
        cause: Schema.Defect(),
        directory: Schema.String,
      }).make({ cause: failures.SECRET, directory: "/work" }),
      "not_found",
    ],
    [
      Schema.TaggedStruct("Session.AgentNotFoundError", {
        agent: Schema.String,
        sessionID: Schema.String,
      }).make({ agent: "oc-advisor-consultation", sessionID: "ses_1" }),
      "not_found",
    ],
    [
      Schema.TaggedStruct("Session.NotFoundError", {
        sessionID: Schema.String,
      }).make({ sessionID: "ses_1" }),
      "not_found",
    ],
    [failures.provider("QuotaExceeded"), "rate_limited"],
    [failures.provider("RateLimit"), "rate_limited"],
    [
      Schema.TaggedStruct("Integration.Authorization", {
        cause: Schema.Defect(),
      }).make({ cause: failures.SECRET }),
      "unauthorized",
    ],
    [failures.provider("Authentication"), "unauthorized"],
    [
      Schema.TaggedStruct("Instructions.InitializationBlocked", {
        keys: Schema.Array(Schema.String),
      }).make({ keys: ["agents"] }),
      "unavailable",
    ],
    [
      Schema.TaggedStruct("SessionRunnerModel.ModelNotSelectedError", {
        sessionID: Schema.String,
      }).make({ sessionID: "ses_1" }),
      "unavailable",
    ],
    [
      Schema.TaggedStruct("SessionRunnerModel.ModelUnavailableError", {
        modelID: Schema.String,
        providerID: Schema.String,
      }).make({ modelID: "claude-opus", providerID: "anthropic" }),
      "unavailable",
    ],
    [
      Schema.TaggedStruct("SessionRunnerModel.VariantUnavailableError", {
        modelID: Schema.String,
        providerID: Schema.String,
        variant: Schema.String,
      }).make({
        modelID: "claude-opus",
        providerID: "anthropic",
        variant: "high",
      }),
      "unavailable",
    ],
    [failures.provider("ProviderInternal"), "unavailable"],
    [failures.provider("Transport"), "unavailable"],
  ] as const,
  /*
   * Failures that name no category this library knows: the HTTP API's
   * tags, which plugins never see, other causes, and unstructured failures
   * whose text names a known tag.
   */
  UNNAMED = [
    Schema.TaggedStruct("SessionNotFoundError", {
      message: Schema.String,
    }).make({ message: failures.SECRET }),
    Schema.TaggedStruct("ServiceUnavailableError", {
      message: Schema.String,
    }).make({ message: failures.SECRET }),
    Schema.TaggedStruct("Session.MessageDecodeError", {
      messageID: Schema.String,
      sessionID: Schema.String,
    }).make({ messageID: "msg_1", sessionID: "ses_1" }),
    failures.provider("ContentPolicy"),
    failures.provider("Timeout"),
    Schema.TaggedStruct("AI.Error", { message: Schema.String }).make({
      message: "RateLimit",
    }),
    { message: "Session.NotFoundError: session not found" },
    "Session.NotFoundError",
  ] as const

describe("a host failure's category", () => {
  it("comes from the failure's structured tag", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      NAMED.map(([failure]) => hostFailure.categorize(failure)),
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
