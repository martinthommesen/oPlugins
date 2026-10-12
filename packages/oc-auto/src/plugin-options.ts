import { Context, Duration, Effect, Layer, Schema } from "effect"
import type { Plugin } from "@opencode/plugin/effect"
import type PluginOptionsError from "@oc-lib/plugin-options/plugin-options-error.ts"
import pluginOptions from "@oc-lib/plugin-options/plugin-options.ts"

interface Interface {
  /** Base URL of the Codex Responses backend. */
  readonly baseUrl: string
  /** Extra policy text appended to the security policy section. */
  readonly extraPolicy: string
  /** Reviewer model used once the backend rejects the primary model. */
  readonly fallbackModel: string
  /** Consecutive denials in one turn before the user is asked instead. */
  readonly maxConsecutiveDenials: number
  /** Total denials in one turn before the user is asked instead. */
  readonly maxTotalDenials: number
  /** Reviewer model requested first. */
  readonly model: string
  /** Reasoning effort requested from the reviewer model. */
  readonly reasoningEffort: (typeof REASONING_EFFORTS)[number]
  /** Deadline for one review, including context loading and fallback. */
  readonly timeout: Duration.Duration
}

const BackendUrl = Schema.URLFromString.check(
    Schema.makeFilter(
      (
        url: Readonly<
          Pick<URL, "protocol" | "username" | "password" | "search" | "hash">
        >,
      ) =>
        ((url.protocol === "https:" || url.protocol === "http:") &&
          url.username === "" &&
          url.password === "" &&
          url.search === "" &&
          url.hash === "") ||
        "Expected an HTTP(S) backend URL without credentials, a query, or a fragment.",
    ),
  ),
  BaseUrl = BackendUrl.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed("https://chatgpt.com/backend-api/codex"),
    ),
  ),
  DEFAULT_MAX_CONSECUTIVE_DENIALS = 3,
  DEFAULT_MAX_TOTAL_DENIALS = 10,
  DenialLimit = Schema.Int.check(
    Schema.isBetween({
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 1,
    }),
  ),
  ExtraPolicy = Schema.String.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("")),
  ),
  FallbackModel = Schema.NonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("gpt-5.5")),
  ),
  MaxConsecutiveDenials = DenialLimit.pipe(
    Schema.withDecodingDefaultKey(
      Effect.succeed(DEFAULT_MAX_CONSECUTIVE_DENIALS),
    ),
  ),
  MaxTotalDenials = DenialLimit.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed(DEFAULT_MAX_TOTAL_DENIALS)),
  ),
  Model = Schema.NonEmptyString.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("codex-auto-review")),
  ),
  REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const,
  ReasoningEffort = Schema.Literals(REASONING_EFFORTS).pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("low")),
  ),
  ReviewTimeout = Schema.DurationFromString.check(
    Schema.makeFilter(
      (duration: Duration.Duration) =>
        (Duration.isFinite(duration) && Duration.isPositive(duration)) ||
        "Expected a positive, finite review timeout.",
    ),
  ),
  Timeout = ReviewTimeout.pipe(
    Schema.withDecodingDefaultKey(Effect.succeed("90 seconds")),
  ),
  /** The plugin options accepted in `opencode.jsonc`, with their defaults. */
  ValidOptions = Schema.Struct({
    baseUrl: BaseUrl,
    extraPolicy: ExtraPolicy,
    fallbackModel: FallbackModel,
    maxConsecutiveDenials: MaxConsecutiveDenials,
    maxTotalDenials: MaxTotalDenials,
    model: Model,
    reasoningEffort: ReasoningEffort,
    timeout: Timeout,
  }),
  /* Decodes the plugin options the host hands over. */
  decodeOptions = pluginOptions.decode(ValidOptions, "oc-auto")

/** The plugin's options, validated, with their defaults. */
class PluginOptions extends Context.Service<PluginOptions, Interface>()(
  "@martinthommesen/oc-auto/plugin-options/PluginOptions",
) {
  /** The reasoning efforts the backend accepts. */
  public static readonly reasoningEfforts = REASONING_EFFORTS

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
          baseUrl: decoded.baseUrl.href,
          extraPolicy: decoded.extraPolicy,
          fallbackModel: decoded.fallbackModel,
          maxConsecutiveDenials: decoded.maxConsecutiveDenials,
          maxTotalDenials: decoded.maxTotalDenials,
          model: decoded.model,
          reasoningEffort: decoded.reasoningEffort,
          timeout: decoded.timeout,
        })
      }),
    )
}

export default PluginOptions
