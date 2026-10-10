import { Config, Context, Duration, Effect, Layer } from "effect"

const ReasoningEffort = ["minimal", "low", "medium", "high"] as const

type ReasoningEffort = (typeof ReasoningEffort)[number]

const DEFAULT_TIMEOUT_SECONDS = 90

const DEFAULT_MAX_CONSECUTIVE_DENIALS = 3

const DEFAULT_MAX_TOTAL_DENIALS = 10

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
  readonly reasoningEffort: ReasoningEffort
  /** Deadline for one review, including the fallback attempt. */
  readonly timeout: Duration.Duration
}

class Settings extends Context.Service<Settings, Interface>()(
  "opencode-auto-review/Settings",
) {
  /** Reads the plugin options through the current `ConfigProvider`. */
  public static readonly layer = Layer.effect(
    Settings,
    Effect.gen(function* readSettings() {
      const baseUrl = yield* Config.url("baseUrl").pipe(
        Config.withDefault(new URL("https://chatgpt.com/backend-api/codex")),
      )

      const extraPolicy = yield* Config.string("extraPolicy").pipe(
        Config.withDefault(""),
      )

      const fallbackModel = yield* Config.nonEmptyString("fallbackModel").pipe(
        Config.withDefault("gpt-5.5"),
      )

      const maxConsecutiveDenials = yield* Config.int(
        "maxConsecutiveDenials",
      ).pipe(Config.withDefault(DEFAULT_MAX_CONSECUTIVE_DENIALS))

      const maxTotalDenials = yield* Config.int("maxTotalDenials").pipe(
        Config.withDefault(DEFAULT_MAX_TOTAL_DENIALS),
      )

      const model = yield* Config.nonEmptyString("model").pipe(
        Config.withDefault("codex-auto-review"),
      )

      const reasoningEffort = yield* Config.literals(
        ReasoningEffort,
        "reasoningEffort",
      ).pipe(Config.withDefault("low"))

      const timeout = yield* Config.duration("timeout").pipe(
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

export { ReasoningEffort, Settings }

export type { Interface as SettingsInterface }
