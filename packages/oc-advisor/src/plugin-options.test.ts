import { Cause, Effect, Exit, Option, Schema } from "effect"
import { assert, describe, it } from "@effect/vitest"
import type { PluginOptions } from "@opencode/plugin/options"
import PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import plugin from "./index.ts"
import support from "./advisor.test-support.ts"

type PluginHost = Parameters<typeof plugin.effect>[typeof FIRST]

const FIRST = 0,
  KNOWN_OPTIONS = "maxTranscriptChars, model, subagents, timeout",
  REGISTRATION = { dispose: Effect.void },
  TIMEOUT = 60,
  TOO_SHORT = 0,
  TRANSCRIPT_CHARS = 50_000,
  /* A host call that registers something, as set-up's calls do. */
  acceptRegistration = (): Effect.Effect<typeof REGISTRATION> =>
    Effect.succeed(REGISTRATION),
  /* A host call set-up must not make. */
  dieIfCalled = (): Effect.Effect<never> =>
    Effect.die("set-up called the host"),
  /* The message set-up fails with when the options have `problems`. */
  failureNaming = (problems: string): Option.Option<string> =>
    Option.some(
      `oc-advisor did not start because its options in opencode.jsonc are invalid. ${problems} Correct the options, then restart OpenCode.`,
    ),
  /* A host with `options` that accepts registrations and fails any other call. */
  hostWith = (options: PluginOptions): PluginHost => ({
    command: { transform: acceptRegistration },
    model: { list: dieIfCalled },
    options,
    session: {
      context: dieIfCalled,
      create: dieIfCalled,
      generate: dieIfCalled,
      get: dieIfCalled,
      hook: acceptRegistration,
      remove: dieIfCalled,
      synthetic: dieIfCalled,
    },
    storage: support.memoryStorage(),
    tool: { transform: acceptRegistration },
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
    ),
  namesEveryProblem = Effect.gen(function* namesEveryProblem() {
    assert.deepStrictEqual(
      yield* invalidOptionsMessage({ subagents: "no", timout: TIMEOUT }),
      failureNaming(
        `timout: Unknown option (known: ${KNOWN_OPTIONS}). subagents: Expected boolean.`,
      ),
    )
  }),
  rejectsMalformedModel = Effect.gen(function* rejectsMalformedModel() {
    assert.deepStrictEqual(
      yield* invalidOptionsMessage({ model: "claude-opus-5-5" }),
      failureNaming(
        "model: Expected provider/model or provider/model#variant.",
      ),
    )
  }),
  rejectsOutOfRange = Effect.gen(function* rejectsOutOfRange() {
    assert.deepStrictEqual(
      yield* invalidOptionsMessage({ timeout: TOO_SHORT }),
      failureNaming("timeout: Expected a value greater than or equal to 1."),
    )
  }),
  rejectsUnknownOption = Effect.gen(function* rejectsUnknownOption() {
    assert.deepStrictEqual(
      yield* invalidOptionsMessage({ subagent: false }),
      failureNaming(`subagent: Unknown option (known: ${KNOWN_OPTIONS}).`),
    )
  }),
  rejectsWrongType = Effect.gen(function* rejectsWrongType() {
    assert.deepStrictEqual(
      yield* invalidOptionsMessage({ timeout: "300" }),
      failureNaming("timeout: Expected number."),
    )
  }),
  startsWithValidOptions = Effect.gen(function* startsWithValidOptions() {
    const exit = yield* plugin
      .effect(
        hostWith({
          maxTranscriptChars: TRANSCRIPT_CHARS,
          model: "anthropic/claude-opus-5-5#high",
          subagents: false,
          timeout: TIMEOUT,
        }),
      )
      .pipe(Effect.scoped, Effect.exit)

    assert.isTrue(Exit.isSuccess(exit))
  })

describe("plugin options", () => {
  it.effect(
    "start the plugin when they are valid",
    () => startsWithValidOptions,
  )
  it.effect(
    "fail set-up on an option of the wrong type",
    () => rejectsWrongType,
  )
  it.effect("fail set-up on an out-of-range value", () => rejectsOutOfRange)
  it.effect("fail set-up on an unknown option name", () => rejectsUnknownOption)
  it.effect(
    "fail set-up on a malformed model reference",
    () => rejectsMalformedModel,
  )
  it.effect("name every problem at once", () => namesEveryProblem)
})
