import { Cause, Effect, Exit, Option, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { PluginOptions } from "@opencode/plugin/options"
import PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import plugin from "./index.ts"

type PluginHost = Parameters<typeof plugin.effect>[typeof FIRST]

const FIRST = 0,
  KNOWN_OPTIONS =
    "baseUrl, extraPolicy, fallbackModel, maxConsecutiveDenials, maxTotalDenials, model, reasoningEffort, timeout",
  REGISTRATION = { dispose: Effect.void },
  TOTAL_DENIALS = 6,
  /* A host call that registers something, as set-up's call does. */
  acceptRegistration = (): Effect.Effect<typeof REGISTRATION> =>
    Effect.succeed(REGISTRATION),
  /* A host call set-up must not make. */
  dieIfCalled = (): Effect.Effect<never> =>
    Effect.die("set-up called the host"),
  /* The message set-up fails with when the options have `problems`. */
  failureNaming = (problems: string): Option.Option<string> =>
    Option.some(
      `oc-auto did not start because its options in opencode.jsonc are invalid. ${problems} Correct the options, then restart OpenCode.`,
    ),
  /* A host with `options` that accepts registrations and fails any other call. */
  hostWith = (options: PluginOptions): PluginHost => ({
    integration: {
      connection: { active: dieIfCalled, resolve: dieIfCalled },
    },
    options,
    permission: { hook: acceptRegistration },
    session: { context: dieIfCalled, get: dieIfCalled },
  }),
  /* The message of the `PluginOptionsError` set-up dies with on `options`, if it does. */
  invalidOptionsMessage = (
    options: PluginOptions,
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
    )

describe("plugin options", () => {
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

describe("invalid plugin options", () => {
  it.effect("fail set-up on an option of the wrong type", () =>
    Effect.gen(function* rejectsWrongType() {
      expect.hasAssertions()
      expect(
        yield* invalidOptionsMessage({ maxTotalDenials: "10" }),
      ).toStrictEqual(failureNaming("maxTotalDenials: Expected number."))
    }),
  )

  it.effect("fail set-up on an invalid value", () =>
    Effect.gen(function* rejectsInvalidValue() {
      expect.hasAssertions()
      expect(
        yield* invalidOptionsMessage({ timeout: "0 seconds" }),
      ).toStrictEqual(
        failureNaming("timeout: Expected a positive, finite review timeout."),
      )
    }),
  )

  it.effect("fail set-up on an unknown option name", () =>
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
