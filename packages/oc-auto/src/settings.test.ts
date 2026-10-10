import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  pipe,
} from "effect"
import type { Config, Scope } from "effect"
import { describe, expect, it } from "@effect/vitest"
import Settings from "./settings.ts"
import support from "./testing.test-support.ts"

const FIRST = 0,
  NINETY_SECONDS = 90,
  TWENTY_SECONDS = 20,
  /* The settings the plugin reads from `options`. */
  settingsOf = (
    options: Parameters<typeof support.settingsFrom>[typeof FIRST],
  ): Effect.Effect<Settings["Service"], Config.ConfigError, Scope.Scope> =>
    Layer.build(support.settingsFrom(options)).pipe(
      Effect.map((built) => Context.get(built, Settings)),
    )

describe("settings", () => {
  it.effect("defaults to Codex auto-review with a GPT-5.5 fallback", () =>
    Effect.gen(function* defaults() {
      expect.hasAssertions()

      const settings = yield* settingsOf({})

      expect(settings).toStrictEqual({
        baseUrl: "https://chatgpt.com/backend-api/codex",
        extraPolicy: "",
        fallbackModel: "gpt-5.5",
        maxConsecutiveDenials: 3,
        maxTotalDenials: 10,
        model: "codex-auto-review",
        reasoningEffort: "low",
        timeout: Duration.seconds(NINETY_SECONDS),
      })
    }),
  )

  it.effect("reads overrides from the plugin options", () =>
    Effect.gen(function* overrides() {
      expect.hasAssertions()

      const settings = yield* settingsOf({
        fallbackModel: "gpt-6-luna",
        reasoningEffort: "medium",
        timeout: "20 seconds",
      })

      expect(settings.fallbackModel).toBe("gpt-6-luna")
      expect(settings.reasoningEffort).toBe("medium")
      expect(settings.timeout).toStrictEqual(Duration.seconds(TWENTY_SECONDS))
    }),
  )

  it.effect("rejects an unknown reasoning effort", () =>
    Effect.gen(function* invalidEffort() {
      expect.hasAssertions()

      const exit = yield* settingsOf({ reasoningEffort: "extreme" }).pipe(
        Effect.exit,
      )

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("denial limit and timeout validation", () => {
  it.effect("rejects zero and negative denial limits", () =>
    Effect.gen(function* invalidLimits() {
      expect.hasAssertions()

      const exits = yield* Effect.all([
        settingsOf({ maxConsecutiveDenials: "-1" }).pipe(Effect.exit),
        settingsOf({ maxTotalDenials: "0" }).pipe(Effect.exit),
      ])

      expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
    }),
  )

  it.effect("rejects nonpositive and infinite review deadlines", () =>
    Effect.gen(function* invalidDeadlines() {
      expect.hasAssertions()

      const exits = yield* Effect.all([
        settingsOf({ timeout: "0 seconds" }).pipe(Effect.exit),
        settingsOf({ timeout: "-1 second" }).pipe(Effect.exit),
        settingsOf({ timeout: "Infinity" }).pipe(Effect.exit),
      ])

      expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
    }),
  )
})

describe("backend URL validation", () => {
  it.effect("rejects unsupported backend URLs", () =>
    Effect.gen(function* invalidUrls() {
      expect.hasAssertions()

      const candidates = [
          "file:///etc/passwd",
          "ftp://example.com/codex",
          "https://user:password@example.com/codex",
          "https://example.com/codex?secret=value",
          "https://example.com/codex#fragment",
        ],
        exits = yield* pipe(
          candidates,
          Effect.forEach((baseUrl) =>
            settingsOf({ baseUrl }).pipe(Effect.exit),
          ),
        )

      expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
    }),
  )
})
