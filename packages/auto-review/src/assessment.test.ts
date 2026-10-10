import { MalformedAssessment, parseAssessment } from "./assessment.ts"
import { describe, expect, it } from "@effect/vitest"
import { Effect } from "effect"

describe(parseAssessment, () => {
  it.effect("reads a full assessment", () =>
    Effect.gen(function* fullAssessment() {
      const assessment = yield* parseAssessment(
        '{"risk_level":"high","user_authorization":"low","outcome":"deny","rationale":"Deletes the home directory."}',
      )

      expect(assessment).toStrictEqual({
        outcome: "deny",
        rationale: "Deletes the home directory.",
        riskLevel: "high",
        userAuthorization: "low",
      })
    }),
  )

  it.effect("reads JSON wrapped in prose", () =>
    Effect.gen(function* wrappedAssessment() {
      const assessment = yield* parseAssessment(
        'Verdict: {"outcome":"allow","risk_level":"medium","rationale":"Scoped write."} Done.',
      )

      expect(assessment.riskLevel).toBe("medium")
    }),
  )

  it.effect("fails on text without a valid assessment", () =>
    Effect.gen(function* malformed() {
      const failure = yield* parseAssessment('{"outcome":"maybe"}').pipe(
        Effect.flip,
      )

      expect(failure).toBeInstanceOf(MalformedAssessment)
      expect(failure.text).toBe('{"outcome":"maybe"}')
    }),
  )
})

describe("parseAssessment defaults", () => {
  it.effect("treats a bare allow as low risk", () =>
    Effect.gen(function* bareAllow() {
      const assessment = yield* parseAssessment('{"outcome":"allow"}')

      expect(assessment).toStrictEqual({
        outcome: "allow",
        rationale: "Auto-review returned a low-risk allow decision.",
        riskLevel: "low",
        userAuthorization: "unknown",
      })
    }),
  )

  it.effect("treats a bare deny as high risk", () =>
    Effect.gen(function* bareDeny() {
      const assessment = yield* parseAssessment(
        '{"outcome":"deny","rationale":"   "}',
      )

      expect(assessment).toStrictEqual({
        outcome: "deny",
        rationale: "Auto-review returned a deny decision without a rationale.",
        riskLevel: "high",
        userAuthorization: "unknown",
      })
    }),
  )
})
