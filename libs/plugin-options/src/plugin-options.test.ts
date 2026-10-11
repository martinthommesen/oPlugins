import { Effect, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import type { PluginOptions } from "@opencode/plugin/options"
import PluginOptionsError from "./plugin-options-error.ts"
import pluginOptions from "./plugin-options.ts"

const BAD_TIMEOUT = 0,
  DEFAULT_TIMEOUT = 30,
  /** A timeout in seconds, above zero, with a default. */
  Deadline = Schema.Int.check(Schema.isGreaterThan(BAD_TIMEOUT)).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_TIMEOUT)),
  ),
  /** A model name, with a default. */
  ModelName = Schema.NonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("default-model")),
  ),
  /** The options of an example plugin, oc-example. */
  Options = Schema.Struct({ model: ModelName, timeout: Deadline }),
  SECRET = "sk-ant-oat01-do-not-echo",
  TIMEOUT = 60,
  decodeEmpty = pluginOptions.decode(Schema.Struct({}), "oc-empty"),
  decodeExample = pluginOptions.decode(Options, "oc-example"),
  /* The message oc-example fails with when its options have `problems`. */
  failureNaming = (problems: string): string =>
    `oc-example did not start because its options in opencode.jsonc are invalid. ${problems} Correct the options, then restart OpenCode.`,
  /* The message decoding `raw` as oc-example's options fails with. */
  messageOf = (raw: PluginOptions): Effect.Effect<string> =>
    decodeExample(raw).pipe(
      Effect.flip,
      Effect.map((failure: { readonly message: string }) => failure.message),
      Effect.orDie,
    )

describe("valid plugin options", () => {
  it.effect("decode, with defaults for absent options", () =>
    Effect.gen(function* decodesValid() {
      expect.hasAssertions()
      expect(yield* decodeExample({ timeout: TIMEOUT })).toStrictEqual({
        model: "default-model",
        timeout: TIMEOUT,
      })
    }),
  )
})

describe("invalid plugin options", () => {
  it.effect("fail on an option of the wrong type", () =>
    Effect.gen(function* rejectsWrongType() {
      expect.hasAssertions()
      expect(yield* messageOf({ timeout: "60" })).toBe(
        failureNaming("timeout: Expected number."),
      )
    }),
  )

  it.effect("fail on an invalid value", () =>
    Effect.gen(function* rejectsInvalidValue() {
      expect.hasAssertions()
      expect(yield* messageOf({ timeout: BAD_TIMEOUT })).toBe(
        failureNaming("timeout: Expected a value greater than 0."),
      )
    }),
  )

  it.effect("fail on an unknown option, listing the known ones", () =>
    Effect.gen(function* rejectsUnknownOption() {
      expect.hasAssertions()
      expect(yield* messageOf({ timout: TIMEOUT })).toBe(
        failureNaming("timout: Unknown option (known: model, timeout)."),
      )
    }),
  )

  it.effect("fail with a PluginOptionsError", () =>
    Effect.gen(function* failsTagged() {
      expect.hasAssertions()
      expect(
        yield* decodeExample({ timeout: BAD_TIMEOUT }).pipe(Effect.flip),
      ).toBeInstanceOf(PluginOptionsError)
    }),
  )
})

describe("the plugin options failure", () => {
  it.effect("names every problem at once", () =>
    Effect.gen(function* namesEveryProblem() {
      expect.hasAssertions()
      expect(
        yield* messageOf({ model: "", timeout: "60", timout: TIMEOUT }),
      ).toBe(
        failureNaming(
          "timout: Unknown option (known: model, timeout). model: Expected a value with a length of at least 1. timeout: Expected number.",
        ),
      )
    }),
  )

  it.effect("never echoes a rejected value", () =>
    Effect.gen(function* keepsValuesOut() {
      expect.hasAssertions()
      expect(
        yield* messageOf({ model: [SECRET], secret: SECRET, timeout: SECRET }),
      ).not.toContain(SECRET)
    }),
  )
})

describe("a plugin with no options", () => {
  it.effect("decodes no options", () =>
    Effect.gen(function* decodesNone() {
      expect.hasAssertions()
      expect(yield* decodeEmpty({})).toStrictEqual({})
    }),
  )

  it.effect("fails on every option, naming each", () =>
    Effect.gen(function* rejectsEveryOption() {
      expect.hasAssertions()
      expect(
        yield* decodeEmpty({ debug: true, verbose: 1 }).pipe(
          Effect.flip,
          Effect.map(
            (failure: { readonly message: string }) => failure.message,
          ),
        ),
      ).toBe(
        "oc-empty did not start because its options in opencode.jsonc are invalid. debug: Unknown option (oc-empty has no options). verbose: Unknown option (oc-empty has no options). Correct the options, then restart OpenCode.",
      )
    }),
  )
})
