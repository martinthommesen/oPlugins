import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"
import MalformedAssessment from "./malformed-assessment-error.ts"
import assessment from "./assessment.ts"

describe("parseAssessment", () => {
  it.effect("reads a full assessment", () =>
    Effect.gen(function* fullAssessment() {
      expect.hasAssertions()

      const parsed = yield* assessment.parse(
        '{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Deletes the home directory."}',
      )

      expect(parsed).toStrictEqual({
        outcome: "deny",
        rationale: "Deletes the home directory.",
        riskLevel: "high",
        userAuthorization: "low",
      })
    }),
  )

  it.effect("reads JSON wrapped in prose", () =>
    Effect.gen(function* wrappedAssessment() {
      expect.hasAssertions()

      const parsed = yield* assessment.parse(
        'Verdict: {"outcome":"allow","risk_level":"medium","rationale":"Scoped write."} Done.',
      )

      expect(parsed.riskLevel).toBe("medium")
    }),
  )

  it.effect("fails on text without a valid assessment", () =>
    Effect.gen(function* malformed() {
      expect.hasAssertions()

      const failure = yield* assessment
        .parse('{"outcome":"maybe"}')
        .pipe(Effect.flip)

      expect(failure).toBeInstanceOf(MalformedAssessment)
      expect(failure.text).toBe('{"outcome":"maybe"}')
    }),
  )
})

describe("parseAssessment defaults", () => {
  it.effect("treats a bare allow as low risk", () =>
    Effect.gen(function* bareAllow() {
      expect.hasAssertions()

      const parsed = yield* assessment.parse('{"outcome":"allow"}')

      expect(parsed).toStrictEqual({
        outcome: "allow",
        rationale: "Auto-review returned a low-risk allow decision.",
        riskLevel: "low",
        userAuthorization: "unknown",
      })
    }),
  )

  it.effect("treats a bare deny as high risk", () =>
    Effect.gen(function* bareDeny() {
      expect.hasAssertions()

      const parsed = yield* assessment.parse(
        '{"outcome":"deny","rationale":"   "}',
      )

      expect(parsed).toStrictEqual({
        outcome: "deny",
        rationale: "Auto-review returned a deny decision without a rationale.",
        riskLevel: "high",
        userAuthorization: "unknown",
      })
    }),
  )
})
