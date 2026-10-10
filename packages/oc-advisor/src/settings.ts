import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import type { PluginOptions } from "@opencode/plugin/options"

const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000,
  DEFAULT_TIMEOUT_SECONDS = 300,
  MIN_TIMEOUT_SECONDS = 1,
  MIN_TRANSCRIPT_CHARS = 1000,
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
    model: Schema.optionalKey(Schema.NonEmptyString),
    subagents: OptionSubagents,
    timeout: OptionTimeout,
  }),
  /** The options in effect when the configured ones are invalid. */
  defaults: typeof Options.Type = {
    maxTranscriptChars: DEFAULT_MAX_TRANSCRIPT_CHARS,
    subagents: true,
    timeout: DEFAULT_TIMEOUT_SECONDS,
  }

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
   * Decodes the plugin options, falling back to defaults when they are
   * invalid so a typo cannot stop OpenCode from loading the plugin.
   */
  public static readonly fromOptions = (
    options: PluginOptions,
  ): Layer.Layer<Settings> =>
    Layer.effect(
      Settings,
      Effect.gen(function* readSettings() {
        const decoded = yield* Schema.decodeEffect(Options)(options).pipe(
          Effect.catchTag("SchemaError", (error) =>
            Effect.as(
              Effect.logError("Invalid oc-advisor options", error),
              defaults,
            ),
          ),
        )

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
