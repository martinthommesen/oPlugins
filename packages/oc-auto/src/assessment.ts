import { Effect, Option, Schema, String as Str } from "effect"
import MalformedAssessment from "./malformed-assessment-error.ts"

type Span = readonly [start: number, end: number]

const OBJECT_END = "}",
  OBJECT_START = "{",
  Outcome = Schema.Literals(["allow", "deny"]),
  RiskLevel = Schema.Literals(["low", "medium", "high", "critical"]),
  UserAuthorization = Schema.Literals(["unknown", "low", "medium", "high"]),
  /** The reviewer's assessment of one planned action. */
  ValidAssessment = Schema.Struct({
    outcome: Outcome,
    rationale: Schema.String,
    riskLevel: RiskLevel,
    userAuthorization: UserAuthorization,
  }),
  /*
   * The reviewer's wire format, which Codex documents in its output
   * contract. Only `outcome` is required; the rest default the way Codex
   * defaults them.
   */
  WirePayload = Schema.Struct({
    outcome: Outcome,
    rationale: Schema.optionalKey(Schema.String),
    risk_level: Schema.optionalKey(RiskLevel),
    user_authorization: Schema.optionalKey(UserAuthorization),
  }),
  decodePayload = Schema.decodeUnknownEffect(
    Schema.fromJsonString(WirePayload),
  ),
  defaultRationale = {
    allow: "Auto-review returned a low-risk allow decision.",
    deny: "Auto-review returned a deny decision without a rationale.",
  } as const satisfies Record<typeof Outcome.Type, string>,
  defaultRiskLevel = {
    allow: "low",
    deny: "high",
  } as const satisfies Record<typeof Outcome.Type, typeof RiskLevel.Type>,
  /* The text from the first `{` to the last `}`, when it holds one. */
  outermostObject = (text: string): Option.Option<string> =>
    Option.all([
      Str.indexOf(OBJECT_START)(text),
      Str.lastIndexOf(OBJECT_END)(text),
    ]).pipe(
      Option.filter(([start, end]: Span) => start < end),
      Option.map(([start, end]: Span) =>
        text.slice(start, end + OBJECT_END.length),
      ),
    ),
  /*
   * Parses the reviewer's final message. Like Codex, it accepts the JSON
   * object wrapped in surrounding prose, but any other deviation is a
   * failure.
   */
  parseAssessment = Effect.fn("Assessment.parse")(function* parseAssessment(
    text: string,
  ) {
    const payload = yield* decodePayload(text).pipe(
        Effect.catch(() =>
          Effect.fromOption(outermostObject(text)).pipe(
            Effect.flatMap(decodePayload),
          ),
        ),
        Effect.mapError(() => MalformedAssessment.make({ text })),
      ),
      rationale = Option.fromUndefinedOr(payload.rationale).pipe(
        Option.map(Str.trim),
        Option.filter(Str.isNonEmpty),
        Option.getOrElse(() => defaultRationale[payload.outcome]),
      )

    return ValidAssessment.make({
      outcome: payload.outcome,
      rationale,
      riskLevel: payload.risk_level ?? defaultRiskLevel[payload.outcome],
      userAuthorization: payload.user_authorization ?? "unknown",
    })
  })

/** The reviewer's assessment, and reading it from the reviewer's final message. */
export default Object.freeze({
  Assessment: ValidAssessment,
  parse: parseAssessment,
})
