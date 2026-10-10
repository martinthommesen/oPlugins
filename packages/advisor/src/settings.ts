import { Context, Duration, Effect, Layer, Option, Schema } from "effect"
import type { PluginOptions } from "@opencode/plugin/options"

const DEFAULT_TIMEOUT_SECONDS = 300

const MIN_TIMEOUT_SECONDS = 1

const DEFAULT_MAX_TRANSCRIPT_CHARS = 200_000

const MIN_TRANSCRIPT_CHARS = 1000

const timeoutField = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(MIN_TIMEOUT_SECONDS),
).pipe(Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_TIMEOUT_SECONDS)))

const maxTranscriptCharsField = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(MIN_TRANSCRIPT_CHARS),
).pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MAX_TRANSCRIPT_CHARS)),
)

const subagentsField = Schema.Boolean.pipe(
  Schema.withDecodingDefaultKey(Effect.succeed(true)),
)

/** The plugin options accepted in `opencode.json(c)`. */
const Options = Schema.Struct({
  maxTranscriptChars: maxTranscriptCharsField,
  model: Schema.optionalKey(Schema.NonEmptyString),
  subagents: subagentsField,
  timeout: timeoutField,
})

const defaults: typeof Options.Type = {
  maxTranscriptChars: DEFAULT_MAX_TRANSCRIPT_CHARS,
  subagents: true,
  timeout: DEFAULT_TIMEOUT_SECONDS,
}

interface Interface {
  /** Character budget for the conversation sent to the advisor. */
  readonly maxTranscriptChars: number
  /** Advisor model used until `/advisor` picks one. */
  readonly model: Option.Option<string>
  /** Whether subagents may consult the advisor until `/advisor` says. */
  readonly subagents: boolean
  /** Deadline for one consultation. */
  readonly timeout: Duration.Duration
}

class Settings extends Context.Service<Settings, Interface>()(
  "opencode-advisor/Settings",
) {
  /**
   * Decodes the plugin options, falling back to defaults when they are
   * invalid so a typo cannot stop OpenCode from loading the plugin.
   * @param {PluginOptions} options The options OpenCode passed in.
   * @returns {Layer.Layer<Settings>} A layer providing `Settings`.
   */
  public static readonly fromOptions = (
    options: PluginOptions,
  ): Layer.Layer<Settings> =>
    Layer.effect(
      Settings,
      Effect.gen(function* readSettings() {
        const decoded = yield* Schema.decodeUnknownEffect(Options)(
          options,
        ).pipe(
          Effect.catch((error) =>
            Effect.as(
              Effect.logError("Invalid opencode-advisor options", error),
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

export { Settings }

export type { Interface as SettingsInterface }
