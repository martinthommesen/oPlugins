import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { Model } from "@opencode/plugin/effect"
import type { Plugin } from "@opencode/plugin/effect"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import pluginOptions from "@oc-lib/plugin-options/plugin-options.ts"

const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000,
  DEFAULT_TIMEOUT_SECONDS = 300,
  MIN_TIMEOUT_SECONDS = 1,
  MIN_TRANSCRIPT_CHARS = 1000,
  /** An advisor model reference, `provider/model[#variant]`. */
  ModelReference = Schema.NonEmptyString.check(
    Schema.makeFilter(
      (model: string) =>
        Option.isSome(Option.liftThrowable(Model.Ref.parse)(model)) ||
        "Expected provider/model or provider/model#variant",
    ),
  ),
  OptionMaxTranscriptChars = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(MIN_TRANSCRIPT_CHARS),
  ).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MAX_TRANSCRIPT_CHARS)),
  ),
  OptionSubagents = Schema.Boolean.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(true)),
  ),
  OptionTimeout = Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(MIN_TIMEOUT_SECONDS),
  ).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_TIMEOUT_SECONDS)),
  ),
  /** The plugin options accepted in `opencode.json(c)`. */
  Options = Schema.Struct({
    /** The character limit for the transcript sent to the advisor. */
    maxTranscriptChars: OptionMaxTranscriptChars,
    /** The advisor model; setting it turns the advisor on. */
    model: Schema.optionalKey(ModelReference),
    /** Whether subagent sessions may consult the advisor. */
    subagents: OptionSubagents,
    /** Seconds a consultation may take before the agent goes on without advice. */
    timeout: OptionTimeout,
  }),
  /* Decodes oc-advisor's options from the host's plugin options. */
  decodeOptions = pluginOptions.decode(Options, "oc-advisor")

/** The plugin options, decoded once when the plugin loads. */
class PluginOptions extends Context.Service<
  PluginOptions,
  {
    /** Character budget for the conversation sent to the advisor. */
    readonly maxTranscriptChars: number
    /** Advisor model used until `/advisor` picks one. */
    readonly model: Option.Option<string>
    /** Whether subagents may consult the advisor until `/advisor` says. */
    readonly subagents: boolean
    /** Deadline for one consultation. */
    readonly timeout: Duration.Duration
  }
>()("@martinthommesen/oc-advisor/plugin-options/PluginOptions") {
  /*
   * Decodes the plugin options. Any invalid or unknown option fails, so a
   * typo stops the plugin from loading instead of passing unnoticed.
   */
  public static readonly fromOptions = (
    options: Plugin.Context["options"],
  ): Layer.Layer<PluginOptions, PluginOptionsError> =>
    Layer.effect(
      PluginOptions,
      Effect.gen(function* readOptions() {
        const decoded = yield* decodeOptions(options)

        return PluginOptions.of({
          maxTranscriptChars: decoded.maxTranscriptChars,
          model: Option.fromUndefinedOr(decoded.model),
          subagents: decoded.subagents,
          timeout: Duration.seconds(decoded.timeout),
        })
      }),
    )
}

export default PluginOptions
