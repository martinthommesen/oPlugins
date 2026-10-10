import { Config, Context, Duration, Effect, Layer, Schema } from "effect"

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
  DEFAULT_MAX_CONSECUTIVE_DENIALS = 3,
  DEFAULT_MAX_TOTAL_DENIALS = 10,
  DEFAULT_TIMEOUT_SECONDS = 90,
  DenialLimit = Schema.Int.check(
    Schema.isBetween({
      maximum: Number.MAX_SAFE_INTEGER,
      minimum: 1,
    }),
  ),
  REASONING_EFFORTS = ["minimal", "low", "medium", "high"] as const,
  ReviewTimeout = Schema.DurationFromString.check(
    Schema.makeFilter(
      (duration: Duration.Duration) =>
        (Duration.isFinite(duration) && Duration.isPositive(duration)) ||
        "Expected a positive, finite review timeout.",
    ),
  )

/** The plugin's options, validated, with their defaults. */
class Settings extends Context.Service<Settings, Interface>()(
  "@martinthommesen/oc-auto/settings",
) {
  /** The reasoning efforts the backend accepts. */
  public static readonly reasoningEfforts = REASONING_EFFORTS

  /** Reads the plugin options through the current `ConfigProvider`. */
  public static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* readSettings() {
      const baseUrl = yield* Config.schema(BackendUrl, "baseUrl").pipe(
          Config.withDefault(new URL("https://chatgpt.com/backend-api/codex")),
        ),
        extraPolicy = yield* Config.string("extraPolicy").pipe(
          Config.withDefault(""),
        ),
        fallbackModel = yield* Config.nonEmptyString("fallbackModel").pipe(
          Config.withDefault("gpt-5.5"),
        ),
        maxConsecutiveDenials = yield* Config.schema(
          DenialLimit,
          "maxConsecutiveDenials",
        ).pipe(Config.withDefault(DEFAULT_MAX_CONSECUTIVE_DENIALS)),
        maxTotalDenials = yield* Config.schema(
          DenialLimit,
          "maxTotalDenials",
        ).pipe(Config.withDefault(DEFAULT_MAX_TOTAL_DENIALS)),
        model = yield* Config.nonEmptyString("model").pipe(
          Config.withDefault("codex-auto-review"),
        ),
        reasoningEffort = yield* Config.literals(
          REASONING_EFFORTS,
          "reasoningEffort",
        ).pipe(Config.withDefault("low")),
        timeout = yield* Config.schema(ReviewTimeout, "timeout").pipe(
          Config.withDefault(Duration.seconds(DEFAULT_TIMEOUT_SECONDS)),
        )

      return Settings.of({
        baseUrl: baseUrl.href,
        extraPolicy,
        fallbackModel,
        maxConsecutiveDenials,
        maxTotalDenials,
        model,
        reasoningEffort,
        timeout,
      })
    }),
  )
}

export default Settings
