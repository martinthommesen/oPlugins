import { Match, Schema } from "effect"

/*
 * Why a call to the host failed, as far as the host's structured failure
 * says: a bounded vocabulary the log may carry. `unknown` covers a failure
 * that names no cause listed here; the host's error text is never read.
 *
 * The plugin context hands a plugin the failures of OpenCode's core services
 * unchanged (`packages/core/src/plugin/host.ts` at v2.0.27), so the tags are
 * the core's own, such as `Session.NotFoundError`, and not those of the HTTP
 * API, such as `SessionNotFoundError`. A model provider's failure arrives as
 * `AI.Error` from `@opencode/ai`, whose `reason` is tagged with the cause.
 */
const Category = Schema.Literals([
    "conflict",
    "invalid_request",
    "not_found",
    "rate_limited",
    "unauthorized",
    "unavailable",
    "unknown",
  ]),
  /* The input conflicts with the session's state. */
  Conflict = Schema.TaggedStruct("Session.SyntheticConflictError", {}),
  /* The model provider rejected the request as invalid. */
  InvalidRequest = Schema.TaggedStruct("AI.Error", {
    reason: Schema.TaggedStruct("InvalidRequest", {}),
  }),
  /* The session, its agent, or its directory doesn't exist. */
  NotFound = Schema.Union([
    Schema.TaggedStruct("FileSystem.DirectoryNotFoundError", {}),
    Schema.TaggedStruct("Session.AgentNotFoundError", {}),
    Schema.TaggedStruct("Session.NotFoundError", {}),
  ]),
  /* The model provider refused the connection's credentials. */
  ProviderRefused = Schema.TaggedStruct("AI.Error", {
    reason: Schema.TaggedStruct("Authentication", {}),
  }),
  /* The model provider failed, or couldn't be reached. */
  ProviderUnavailable = Schema.TaggedStruct("AI.Error", {
    reason: Schema.Union([
      Schema.TaggedStruct("ProviderInternal", {}),
      Schema.TaggedStruct("Transport", {}),
    ]),
  }),
  /* The model provider is limiting requests, or the quota ran out. */
  RateLimited = Schema.TaggedStruct("AI.Error", {
    reason: Schema.Union([
      Schema.TaggedStruct("QuotaExceeded", {}),
      Schema.TaggedStruct("RateLimit", {}),
    ]),
  }),
  /* The connection couldn't be authorized, or the provider refused it. */
  Unauthorized = Schema.Union([
    Schema.TaggedStruct("Integration.Authorization", {}),
    ProviderRefused,
  ]),
  /*
   * No model is available to the session, an instruction source is
   * unavailable, or the model provider is.
   */
  Unavailable = Schema.Union([
    Schema.TaggedStruct("Instructions.InitializationBlocked", {}),
    Schema.TaggedStruct("SessionRunnerModel.ModelNotSelectedError", {}),
    Schema.TaggedStruct("SessionRunnerModel.ModelUnavailableError", {}),
    Schema.TaggedStruct("SessionRunnerModel.VariantUnavailableError", {}),
    ProviderUnavailable,
  ]),
  /* The category of what a host call failed with. */
  categorize = (cause: unknown): typeof Category.Type =>
    Match.value(cause).pipe(
      Match.when(Schema.is(Conflict), () => "conflict" as const),
      Match.when(Schema.is(InvalidRequest), () => "invalid_request" as const),
      Match.when(Schema.is(NotFound), () => "not_found" as const),
      Match.when(Schema.is(RateLimited), () => "rate_limited" as const),
      Match.when(Schema.is(Unauthorized), () => "unauthorized" as const),
      Match.when(Schema.is(Unavailable), () => "unavailable" as const),
      Match.orElse(() => "unknown" as const),
    )

/** The categories of the host's failures, and how a failure gets one. */
export default Object.freeze({ Category, categorize })
