import { Match, Schema } from "effect"

/*
 * Why a call to the host failed, as far as the host's structured failure
 * says: a bounded vocabulary the log may carry. `unknown` covers a failure
 * that names no cause listed here; the host's error text is never read.
 */
const Category = Schema.Literals([
    "conflict",
    "invalid_request",
    "not_found",
    "unauthorized",
    "unavailable",
    "unknown",
  ]),
  /* The host's failures that name a conflict with the session's state. */
  Conflict = Schema.Union([
    Schema.TaggedStruct("ConflictError", {}),
    Schema.TaggedStruct("SessionBusyError", {}),
  ]),
  /* The host's failure that names a request it rejected. */
  InvalidRequest = Schema.TaggedStruct("InvalidRequestError", {}),
  /* The host's failures that name something missing. */
  NotFound = Schema.Union([
    Schema.TaggedStruct("AgentNotFoundError", {}),
    Schema.TaggedStruct("LocationNotFoundError", {}),
    Schema.TaggedStruct("MessageNotFoundError", {}),
    Schema.TaggedStruct("ProviderNotFoundError", {}),
    Schema.TaggedStruct("SessionNotFoundError", {}),
  ]),
  /* The host's failures that name a refused caller. */
  Unauthorized = Schema.Union([
    Schema.TaggedStruct("ForbiddenError", {}),
    Schema.TaggedStruct("UnauthorizedError", {}),
  ]),
  /* The host's failure that names a service it can't reach. */
  Unavailable = Schema.TaggedStruct("ServiceUnavailableError", {}),
  /* The category of what a host call failed with. */
  categorize = (cause: unknown): typeof Category.Type =>
    Match.value(cause).pipe(
      Match.when(Schema.is(Conflict), () => "conflict" as const),
      Match.when(Schema.is(InvalidRequest), () => "invalid_request" as const),
      Match.when(Schema.is(NotFound), () => "not_found" as const),
      Match.when(Schema.is(Unauthorized), () => "unauthorized" as const),
      Match.when(Schema.is(Unavailable), () => "unavailable" as const),
      Match.orElse(() => "unknown" as const),
    )

/** The categories of the host's failures, and how a failure gets one. */
export default Object.freeze({ Category, categorize })
