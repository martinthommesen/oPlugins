import { describe, expect, it as test } from "@effect/vitest"
import { Effect } from "effect"
import Environment from "./environment.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import claudeHeaders from "./claude-headers.ts"
import testEnvironment from "./test-environment.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given its services. */
interface Tests {
  readonly effect: Vitest.Test<Environment | Scope.Scope>
}

const EFFORT = "effort-2025-11-24",
  FIVE_ASSERTIONS = 5,
  HOME = "/nonexistent-claude-auth-home",
  ONE_ASSERTION = 1,
  TWO_ASSERTIONS = 2,
  /* The anthropic-beta flags in `headers`. */
  betasOf = (headers: Headers): readonly string[] =>
    String(headers.get("anthropic-beta")).split(","),
  /* An environment of `variables` plus a home. */
  environmentOf = (
    variables: Readonly<Record<string, string>> = {},
  ): ReturnType<ReturnType<typeof testEnvironment>> =>
    testEnvironment(
      Object.fromEntries([["HOME", HOME], ...Object.entries(variables)]),
    )(),
  /* The Claude Code headers for a request carrying `original`, for `model`. */
  headersFor = (
    original: Readonly<Record<string, string>>,
    model: string,
  ): Effect.Effect<Headers, never, Environment> =>
    Effect.gen(function* build() {
      const environment = yield* Environment

      return claudeHeaders.build(
        {
          accessToken: "access",
          modelID: model,
          original: new Headers(original),
          requestID: "request",
          sessionID: "session",
        },
        environment.variables,
        environment.process,
      )
    })

describe("claude headers merged with the caller's", () => {
  test.layer(environmentOf())((it: Tests) => {
    it.effect(
      "merges required headers, preserves custom headers, and removes x-api-key",
      () =>
        Effect.gen(function* run() {
          expect.assertions(FIVE_ASSERTIONS)

          const headers = yield* headersFor(
            {
              "anthropic-beta": "custom-beta,oauth-2025-04-20",
              "x-api-key": "key",
              "x-custom": "keep",
            },
            "claude-opus-4-6",
          )

          expect(headers.get("authorization")).toBe("Bearer access")
          expect(headers.has("x-api-key")).toBe(false)
          expect(headers.get("x-custom")).toBe("keep")
          expect(headers.get("anthropic-version")).toBe("2023-06-01")
          expect(headers.get("anthropic-dangerous-direct-browser-access")).toBe(
            "true",
          )
        }),
    )
  })

  test.layer(environmentOf())((it: Tests) => {
    it.effect("merges the caller's betas with the model's", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const headers = yield* headersFor(
          { "anthropic-beta": "custom-beta,oauth-2025-04-20" },
          "claude-opus-4-6",
        )

        expect(betasOf(headers)).toContain("custom-beta")
        expect(betasOf(headers)).toContain(EFFORT)
      }),
    )
  })
})

test.layer(environmentOf())("claude headers betas", (it: Tests) => {
  it.effect(
    "strips a model's excluded betas even when the caller sent them",
    () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const headers = yield* headersFor(
          { "anthropic-beta": `${EFFORT},custom-beta` },
          "claude-sonnet-4-5",
        )

        expect(betasOf(headers)).toContain("custom-beta")
        expect(betasOf(headers)).not.toContain(EFFORT)
      }),
  )
})

describe("claude headers replacing the caller's", () => {
  test.layer(environmentOf())((it: Tests) => {
    it.effect(
      "drops a copied content-length because the body is re-serialized",
      () =>
        Effect.gen(function* run() {
          expect.assertions(ONE_ASSERTION)

          const headers = yield* headersFor(
            { "content-length": "999" },
            "claude-opus-5",
          )

          expect(headers.has("content-length")).toBe(false)
        }),
    )
  })

  test.layer(environmentOf())((it: Tests) => {
    it.effect(
      "keeps a retry count the SDK already set and defaults an absent one",
      () =>
        Effect.gen(function* run() {
          expect.assertions(TWO_ASSERTIONS)

          const fresh = yield* headersFor({}, "claude-opus-5-5"),
            retried = yield* headersFor(
              { "x-stainless-retry-count": "3" },
              "claude-opus-5-5",
            )

          // A retried request must not be reported as a first attempt.
          expect(retried.get("x-stainless-retry-count")).toBe("3")
          expect(fresh.get("x-stainless-retry-count")).toBe("0")
        }),
    )
  })
})

describe("claude headers identity", () => {
  test.layer(environmentOf({ CLAUDE_CODE_ENTRYPOINT: "cli" }))((it: Tests) => {
    it.effect(
      "uses the configured entrypoint consistently in the user agent",
      () =>
        Effect.gen(function* run() {
          expect.assertions(ONE_ASSERTION)
          expect(
            (yield* headersFor({}, "claude-opus-5-5")).get("user-agent"),
          ).toMatch(/\(external, cli\)$/u)
        }),
    )
  })

  test.layer(environmentOf())((it: Tests) => {
    it.effect("identifies as the Claude Code CLI by default", () =>
      Effect.gen(function* run() {
        expect.assertions(TWO_ASSERTIONS)

        const headers = yield* headersFor({}, "claude-opus-5-5")

        expect(headers.get("x-app")).toBe("cli")
        // The version is the literal in model-config.ts; bump both together.
        expect(headers.get("user-agent")).toBe(
          "claude-cli/2.1.295 (external, sdk-cli)",
        )
      }),
    )
  })

  test.layer(
    environmentOf({
      ANTHROPIC_USER_AGENT: "custom-agent/9.9",
      CLAUDE_CODE_ENTRYPOINT: "cli",
    }),
  )((it: Tests) => {
    it.effect("lets ANTHROPIC_USER_AGENT replace the user agent verbatim", () =>
      Effect.gen(function* run() {
        expect.assertions(ONE_ASSERTION)
        expect(
          (yield* headersFor({}, "claude-opus-5-5")).get("user-agent"),
        ).toBe("custom-agent/9.9")
      }),
    )
  })
})
