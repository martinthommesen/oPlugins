import {
  Array as Arr,
  Cause,
  Context,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schema,
  pipe,
} from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import PluginOptions from "./plugin-options.ts"
import PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import type { Scope } from "effect"
import type { Vitest } from "@effect/vitest"
import plugin from "./index.ts"

type PluginHost = Parameters<typeof plugin.effect>[typeof FIRST]

/** The `it` of a `test.layer` block: `it.effect`, given the options. */
interface Tests {
  readonly effect: Vitest.Test<PluginOptions | Scope.Scope>
}

/** The `it` of a `test.layer` block that provides no services. */
interface PureTests {
  readonly effect: Vitest.Test<Scope.Scope>
}

const FIRST = 0,
  KNOWN_OPTIONS =
    "baseUrl, extraPolicy, fallbackModel, maxConsecutiveDenials, maxTotalDenials, model, reasoningEffort, timeout",
  NEGATIVE_LIMIT = -1,
  NINETY_SECONDS = 90,
  REGISTRATION = { dispose: Effect.void },
  TOTAL_DENIALS = 6,
  TWENTY_SECONDS = 20,
  ZERO_LIMIT = 0,
  /* A host call that registers something, as setup's call does. */
  acceptRegistration = (): Effect.Effect<typeof REGISTRATION> =>
    Effect.succeed(REGISTRATION),
  /* A host call setup must not make. */
  dieIfCalled = (): Effect.Effect<never> => Effect.die("setup called the host"),
  /* The message setup fails with when the options have `problems`. */
  failureNaming = (problems: string): Option.Option<string> =>
    Option.some(
      `oc-auto did not start because its options in opencode.jsonc are invalid. ${problems} Correct the options, then restart OpenCode.`,
    ),
  /* A host with `options` that accepts registrations and fails any other call. */
  hostWith = (options: PluginHost["options"]): PluginHost => ({
    integration: {
      connection: { active: dieIfCalled, resolve: dieIfCalled },
    },
    options,
    permission: { hook: acceptRegistration },
    session: { context: dieIfCalled, get: dieIfCalled },
  }),
  /* The message of the `PluginOptionsError` setup dies with on `options`, if it does. */
  invalidOptionsMessage = (
    options: PluginHost["options"],
  ): Effect.Effect<Option.Option<string>> =>
    plugin.effect(hostWith(options)).pipe(
      Effect.scoped,
      Effect.sandbox,
      Effect.match({
        onFailure: (cause) =>
          Option.liftPredicate(
            Cause.squash(cause),
            Schema.is(PluginOptionsError),
          ).pipe(
            Option.map(
              (failure: { readonly message: string }) => failure.message,
            ),
          ),
        onSuccess: () => Option.none<string>(),
      }),
    ),
  /* The options the plugin reads from raw `options`, built in their own scope. */
  optionsOf = (
    options: Parameters<typeof PluginOptions.fromOptions>[typeof FIRST],
  ): Effect.Effect<PluginOptions["Service"], PluginOptionsError> =>
    Layer.build(PluginOptions.fromOptions(options)).pipe(
      Effect.map((built) => Context.get(built, PluginOptions)),
      Effect.scoped,
    ),
  /** Plugin options that override the defaults. */
  overridden = PluginOptions.fromOptions({
    fallbackModel: "gpt-6-luna",
    reasoningEffort: "medium",
    timeout: "20 seconds",
  })

describe("plugin options", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("start the plugin when they are valid", () =>
      Effect.gen(function* startsWithValidOptions() {
        expect.hasAssertions()

        const exit = yield* plugin
          .effect(
            hostWith({
              fallbackModel: "gpt-6-luna",
              maxTotalDenials: TOTAL_DENIALS,
              reasoningEffort: "medium",
              timeout: "60 seconds",
            }),
          )
          .pipe(Effect.scoped, Effect.exit)

        expect(Exit.isSuccess(exit)).toBe(true)
      }),
    )
  })
})

describe("invalid plugin options", () => {
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("fail setup on an option of the wrong type", () =>
      Effect.gen(function* rejectsWrongType() {
        expect.hasAssertions()
        expect(
          yield* invalidOptionsMessage({ maxTotalDenials: "10" }),
        ).toStrictEqual(failureNaming("maxTotalDenials: Expected number."))
      }),
    )

    it.effect("fail setup on an invalid value", () =>
      Effect.gen(function* rejectsInvalidValue() {
        expect.hasAssertions()
        expect(
          yield* invalidOptionsMessage({ timeout: "0 seconds" }),
        ).toStrictEqual(
          failureNaming("timeout: Expected a positive, finite review timeout."),
        )
      }),
    )

    it.effect("fail setup on an unknown option name", () =>
      Effect.gen(function* rejectsUnknownOption() {
        expect.hasAssertions()
        expect(
          yield* invalidOptionsMessage({ fallback: "gpt-6-luna" }),
        ).toStrictEqual(
          failureNaming(`fallback: Unknown option (known: ${KNOWN_OPTIONS}).`),
        )
      }),
    )
  })
})

describe("options", () => {
  test.layer(PluginOptions.fromOptions({}))((it: Tests) => {
    it.effect("defaults to Codex auto-review with a GPT-5.5 fallback", () =>
      Effect.gen(function* defaults() {
        expect.hasAssertions()

        const options = yield* PluginOptions

        expect(options).toStrictEqual({
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

        const options = yield* PluginOptions

        expect(options.fallbackModel).toBe("gpt-6-luna")
        expect(options.reasoningEffort).toBe("medium")
        expect(options.timeout).toStrictEqual(Duration.seconds(TWENTY_SECONDS))
      }),
    )
  })
  test.layer(Layer.empty)((it: PureTests) => {
    it.effect("rejects an unknown reasoning effort", () =>
      Effect.gen(function* invalidEffort() {
        expect.hasAssertions()

        const failure = yield* optionsOf({ reasoningEffort: "extreme" }).pipe(
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
          optionsOf({ maxConsecutiveDenials: NEGATIVE_LIMIT }).pipe(
            Effect.exit,
          ),
          optionsOf({ maxTotalDenials: ZERO_LIMIT }).pipe(Effect.exit),
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
          optionsOf({ timeout: "0 seconds" }).pipe(Effect.exit),
          optionsOf({ timeout: "-1 second" }).pipe(Effect.exit),
          optionsOf({ timeout: "Infinity" }).pipe(Effect.exit),
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
              optionsOf({ baseUrl }).pipe(Effect.exit),
            ),
          )

        expect(pipe(exits, Arr.every(Exit.isFailure))).toBe(true)
      }),
    )
  })
})
