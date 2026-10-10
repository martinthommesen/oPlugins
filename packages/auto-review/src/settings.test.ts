import { Array as Arr, Duration, Effect, Exit, pipe } from "effect"
import { describe, expect, it } from "@effect/vitest"
import { Settings } from "./settings.ts"
import { settingsFrom } from "./testing.ts"

const TWENTY_SECONDS = 20

const NINETY_SECONDS = 90

const readSettings = Effect.gen(function* readSettings() {
  return yield* Settings
})

describe("settings", () => {
  it.effect("defaults to Codex auto-review with a GPT-5.5 fallback", () =>
    Effect.gen(function* defaults() {
      const settings = yield* Effect.provide(readSettings, settingsFrom({}))

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
      const settings = yield* Effect.provide(
        readSettings,
        settingsFrom({
          fallbackModel: "gpt-6-luna",
          reasoningEffort: "medium",
          timeout: "20 seconds",
        }),
      )

      expect(settings.fallbackModel).toBe("gpt-6-luna")
      expect(settings.reasoningEffort).toBe("medium")
      expect(settings.timeout).toStrictEqual(Duration.seconds(TWENTY_SECONDS))
    }),
  )

  it.effect("rejects an unknown reasoning effort", () =>
    Effect.gen(function* invalidEffort() {
      const exit = yield* Effect.provide(
        readSettings,
        settingsFrom({ reasoningEffort: "extreme" }),
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
    }),
  )
})

describe("denial limit and timeout validation", () => {
  it.effect("rejects zero and negative denial limits", () =>
    Effect.gen(function* invalidLimits() {
      const exits = yield* Effect.all([
        Effect.provide(
          readSettings,
          settingsFrom({ maxConsecutiveDenials: "-1" }),
        ).pipe(Effect.exit),
        Effect.provide(
          readSettings,
          settingsFrom({ maxTotalDenials: "0" }),
        ).pipe(Effect.exit),
      ])

      expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
    }),
  )

  it.effect("rejects nonpositive and infinite review deadlines", () =>
    Effect.gen(function* invalidDeadlines() {
      const exits = yield* Effect.all([
        Effect.provide(
          readSettings,
          settingsFrom({ timeout: "0 seconds" }),
        ).pipe(Effect.exit),
        Effect.provide(
          readSettings,
          settingsFrom({ timeout: "-1 second" }),
        ).pipe(Effect.exit),
        Effect.provide(
          readSettings,
          settingsFrom({ timeout: "Infinity" }),
        ).pipe(Effect.exit),
      ])

      expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
    }),
  )
})

describe("backend URL validation", () => {
  it.effect("rejects unsupported backend URLs", () =>
    Effect.gen(function* invalidUrls() {
      const urls = [
        "file:///etc/passwd",
        "ftp://example.com/codex",
        "https://user:password@example.com/codex",
        "https://example.com/codex?secret=value",
        "https://example.com/codex#fragment",
      ]

      const exits = yield* pipe(
        urls,
        Effect.forEach((baseUrl) =>
          Effect.provide(readSettings, settingsFrom({ baseUrl })).pipe(
            Effect.exit,
          ),
        ),
      )

      expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
    }),
  )
})
