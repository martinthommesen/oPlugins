import { Effect, Option, Schema, String as Str } from "effect"

const RiskLevel = Schema.Literals(["low", "medium", "high", "critical"])

type RiskLevel = typeof RiskLevel.Type

const UserAuthorization = Schema.Literals(["unknown", "low", "medium", "high"])

type UserAuthorization = typeof UserAuthorization.Type

const Outcome = Schema.Literals(["allow", "deny"])

type Outcome = typeof Outcome.Type

const Assessment = Schema.Struct({
  outcome: Outcome,
  rationale: Schema.String,
  riskLevel: RiskLevel,
  userAuthorization: UserAuthorization,
})

interface Assessment extends Schema.Schema.Type<typeof Assessment> {}

class MalformedAssessment extends Schema.TaggedError<MalformedAssessment>()(
  "MalformedAssessment",
  { text: Schema.String },
) {}

// The reviewer's wire format, which Codex documents in its output contract.
// Only `outcome` is required; the rest default the way Codex defaults them.
const Payload = Schema.Struct({
  outcome: Outcome,
  rationale: Schema.optionalKey(Schema.String),
  risk_level: Schema.optionalKey(RiskLevel),
  user_authorization: Schema.optionalKey(UserAuthorization),
})

const decodePayload = Schema.decodeUnknownEffect(Schema.fromJsonString(Payload))

const defaultRiskLevel = {
  allow: "low",
  deny: "high",
} as const satisfies Record<Outcome, RiskLevel>

const defaultRationale = {
  allow: "Auto-review returned a low-risk allow decision.",
  deny: "Auto-review returned a deny decision without a rationale.",
} as const satisfies Record<Outcome, string>

const OBJECT_START = "{"

const OBJECT_END = "}"

type Span = readonly [start: number, end: number]

const outermostObject = (text: string): Option.Option<string> =>
  Option.all([
    Str.indexOf(OBJECT_START)(text),
    Str.lastIndexOf(OBJECT_END)(text),
  ]).pipe(
    Option.filter(([start, end]: Span) => start < end),
    Option.map(([start, end]: Span) =>
      text.slice(start, end + OBJECT_END.length),
    ),
  )

/**
 * Parses the reviewer's final message. Like Codex, it accepts the JSON object
 * wrapped in surrounding prose, but any other deviation is a failure.
 */
const parseAssessment = Effect.fn("Assessment.parse")(function* parseAssessment(
  text: string,
) {
  const payload = yield* decodePayload(text).pipe(
    Effect.catch(() =>
      Effect.fromOption(outermostObject(text)).pipe(
        Effect.flatMap(decodePayload),
      ),
    ),
    Effect.mapError(() => new MalformedAssessment({ text })),
  )

  const rationale = Option.fromUndefinedOr(payload.rationale).pipe(
    Option.map(Str.trim),
    Option.filter(Str.isNonEmpty),
    Option.getOrElse(() => defaultRationale[payload.outcome]),
  )

  return Assessment.make({
    outcome: payload.outcome,
    rationale,
    riskLevel: payload.risk_level ?? defaultRiskLevel[payload.outcome],
    userAuthorization: payload.user_authorization ?? "unknown",
  })
})

export { Assessment, MalformedAssessment, Outcome, parseAssessment, RiskLevel }

export type { UserAuthorization }
