import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import { Model } from "@opencode/plugin/effect"
import type { PluginOptions } from "@opencode/plugin/options"
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
    maxTranscriptChars: OptionMaxTranscriptChars,
    model: Schema.optionalKey(ModelReference),
    subagents: OptionSubagents,
    timeout: OptionTimeout,
  }),
  /* The plugin options in the host's options, decoded. */
  decodeOptions = pluginOptions.decode(Options, "oc-advisor")

/** The plugin options, decoded once when the plugin loads. */
class Settings extends Context.Service<
  Settings,
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
>()("@martinthommesen/oc-advisor/settings") {
  /*
   * Decodes the plugin options. Any invalid or unknown option fails, so a
   * typo stops the plugin from loading instead of passing unnoticed.
   */
  public static readonly fromOptions = (
    options: PluginOptions,
  ): Layer.Layer<Settings, PluginOptionsError> =>
    Layer.effect(
      Settings,
      Effect.gen(function* readSettings() {
        const decoded = yield* decodeOptions(options)

        return Settings.of({
          maxTranscriptChars: decoded.maxTranscriptChars,
          model: Option.fromUndefinedOr(decoded.model),
          subagents: decoded.subagents,
          timeout: Duration.seconds(decoded.timeout),
        })
      }),
    )
}

export default Settings
