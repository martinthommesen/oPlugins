import {
  Array as Arr,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  pipe,
} from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import type { Scope } from "effect"
import Settings from "./settings.ts"
import type { Vitest } from "@effect/vitest"
import support from "./testing.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, given the settings. */
interface Tests {
  readonly effect: Vitest.Test<Settings | Scope.Scope>
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

const FIRST = 0,
  NEGATIVE_LIMIT = -1,
  NINETY_SECONDS = 90,
  TWENTY_SECONDS = 20,
  ZERO_LIMIT = 0,
  /** Settings from plugin options that override the defaults. */
  overridden = support.settingsFrom({
    fallbackModel: "gpt-6-luna",
    reasoningEffort: "medium",
    timeout: "20 seconds",
  }),
  /* The settings the plugin reads from `options`, built in their own scope. */
  settingsOf = (
    options: Parameters<typeof support.settingsFrom>[typeof FIRST],
  ): Effect.Effect<Settings["Service"], PluginOptionsError> =>
    Layer.build(support.settingsFrom(options)).pipe(
      Effect.map((built) => Context.get(built, Settings)),
      Effect.scoped,
    )

describe("settings", () => {
  test.layer(support.settingsFrom({}))((it: Tests) => {
    it.effect("defaults to Codex auto-review with a GPT-5.5 fallback", () =>
      Effect.gen(function* defaults() {
        expect.hasAssertions()

        const settings = yield* Settings

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
  })
  test.layer(overridden)((it: Tests) => {
    it.effect("reads overrides from the plugin options", () =>
      Effect.gen(function* overrides() {
        expect.hasAssertions()

        const settings = yield* Settings

        expect(settings.fallbackModel).toBe("gpt-6-luna")
        expect(settings.reasoningEffort).toBe("medium")
        expect(settings.timeout).toStrictEqual(Duration.seconds(TWENTY_SECONDS))
      }),
    )
  })
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("rejects an unknown reasoning effort", () =>
      Effect.gen(function* invalidEffort() {
        expect.hasAssertions()

        const failure = yield* settingsOf({ reasoningEffort: "extreme" }).pipe(
          Effect.flip,
        )

        expect(failure.message).toContain(
          'reasoningEffort: Expected "minimal" | "low" | "medium" | "high".',
        )
      }),
    )
  })
})

describe("denial limit and timeout validation", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("rejects zero and negative denial limits", () =>
      Effect.gen(function* invalidLimits() {
        expect.hasAssertions()

        const exits = yield* Effect.all([
          settingsOf({ maxConsecutiveDenials: NEGATIVE_LIMIT }).pipe(
            Effect.exit,
          ),
          settingsOf({ maxTotalDenials: ZERO_LIMIT }).pipe(Effect.exit),
        ])

        expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
      }),
    )
  })
  test.layer(Layer.empty)((it: PureTests) => {
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
})

describe("backend URL validation", () => {
  test.layer(Layer.empty)((it: PureTests) => {
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
})
