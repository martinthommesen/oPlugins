import { Context, Duration, Effect, Layer, Schema } from "effect"
import InvalidOptions from "./invalid-options-error.ts"
import type { PluginOptions } from "@opencode/plugin/options"

interface Interface {
  /** Base URL of the Codex Responses backend. */
  readonly baseUrl: string
  /** Extra policy text appended to the security policy section. */
  readonly extraPolicy: string
  /** Model used when the primary model is unavailable to the account. */
  readonly fallbackModel: string
  /** Consecutive denials in one turn before the user is asked instead. */
  readonly maxConsecutiveDenials: number
  /** Total denials in one turn before the user is asked instead. */
  readonly maxTotalDenials: number
  /** Reviewer model requested first. */
  readonly model: string
  readonly reasoningEffort: (typeof REASONING_EFFORTS)[number]
  /** Deadline for one review, including the fallback attempt. */
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
  }).annotate({ messageUnexpectedKey: "Unknown option" })

/** The plugin's options, validated, with their defaults. */
class Settings extends Context.Service<Settings, Interface>()(
  "@martinthommesen/oc-auto/settings",
) {
  /** The reasoning efforts the backend accepts. */
  public static readonly reasoningEfforts = REASONING_EFFORTS

  /*
   * Decodes the plugin options. Any invalid or unknown option fails, so a
   * typo stops the plugin from loading instead of passing unnoticed.
   */
  public static readonly fromOptions = (
    options: PluginOptions,
  ): Layer.Layer<Settings, InvalidOptions> =>
    Layer.effect(
      Settings,
      Effect.gen(function* readSettings() {
        const decoded = yield* Schema.decodeEffect(ValidOptions)(options, {
          errors: "all",
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError((failure) => InvalidOptions.fromIssue(failure.issue)),
        )

        return Settings.of({
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

export default Settings
