import { Config, Context, Effect, Layer, Option, Schema } from "effect"

// A C0 or C1 control character would break out of a header slot.
const CONTROL_CHARACTERS = /\p{Cc}/gu,
  DEFAULT_LOCK_TTL_MS = 20_000,
  DEFAULT_REFRESH_COOLDOWN_MS = 15_000,
  DEFAULT_SECURITY_BINARY = "/usr/bin/security",
  MINIMUM_EXCLUSIVE = 0,
  PositiveIntFromString = Schema.NumberFromString.check(
    Schema.isInt(),
    Schema.isGreaterThan(MINIMUM_EXCLUSIVE),
  ),
  /** Facts about the running process, which tests replace. */
  ProcessFacts = Schema.Struct({
    arch: Schema.String,
    nodeVersion: Schema.String,
    pid: Schema.Number,
    platform: Schema.String,
  }),
  /*
   * A positive integer, or `fallback` when unset or invalid. A typo in a
   * tuning knob must not stop the plugin from loading.
   */
  positiveInt = (name: string, fallback: number): Config.Config<number> =>
    Config.schema(PositiveIntFromString, name).pipe(
      Config.orElse(() => Config.succeed(fallback)),
    ),
  // A non-empty variable, or none when it is unset or empty.
  present = (name: string): Config.Config<Option.Option<string>> =>
    Config.option(Config.nonEmptyString(name)),
  /*
   * A single-line variable. These land in request headers and system prompt
   * blocks, so every control character becomes a space. A value of only
   * control characters yields "", which still overrides the fallback.
   */
  singleLine = (name: string): Config.Config<Option.Option<string>> =>
    present(name).pipe(
      Config.map(
        Option.map((raw) => raw.replaceAll(CONTROL_CHARACTERS, " ").trim()),
      ),
    ),
  /** Variables the plugin reads, decoded once when it loads. */
  variables = Config.all({
    betaFlags: Config.option(Config.string("ANTHROPIC_BETA_FLAGS")),
    claudeConfigDir: present("CLAUDE_CONFIG_DIR"),
    cliVersion: singleLine("ANTHROPIC_CLI_VERSION"),
    debug: present("CLAUDE_AUTH_DEBUG"),
    entrypoint: singleLine("CLAUDE_CODE_ENTRYPOINT"),
    home: Config.nonEmptyString("HOME").pipe(
      Config.orElse(() => Config.nonEmptyString("USERPROFILE")),
    ),
    lockDir: present("OC_AUTH_REFRESH_LOCK_DIR"),
    lockTtlMs: positiveInt("OC_AUTH_REFRESH_LOCK_TTL_MS", DEFAULT_LOCK_TTL_MS),
    refreshCooldownMs: positiveInt(
      "OC_AUTH_REFRESH_COOLDOWN_MS",
      DEFAULT_REFRESH_COOLDOWN_MS,
    ),
    securityBinary: Config.nonEmptyString("OC_AUTH_SECURITY_BIN").pipe(
      Config.withDefault(DEFAULT_SECURITY_BINARY),
    ),
    userAgent: singleLine("ANTHROPIC_USER_AGENT"),
    xdgDataHome: present("XDG_DATA_HOME"),
  })

/**
 * Everything the plugin reads from its environment: variables, decoded once
 * when it loads, and facts about the process. Nothing else reads
 * `process.env` or `process`.
 */
class Environment extends Context.Service<
  Environment,
  {
    readonly process: typeof ProcessFacts.Type
    readonly variables: Config.Success<typeof variables>
  }
>()("@martinthommesen/oc-auth/environment") {
  /* The variables from the current `ConfigProvider`, with `facts` as the process facts. */
  public static readonly layerWith = (
    facts: typeof ProcessFacts.Type,
  ): Layer.Layer<Environment, Config.ConfigError> =>
    Layer.effect(
      Environment,
      Effect.gen(function* decode() {
        return Environment.of({ process: facts, variables: yield* variables })
      }),
    )

  /** The live environment of this process. */
  public static readonly layer: Layer.Layer<Environment, Config.ConfigError> =
    Layer.unwrap(
      Effect.sync(() =>
        Environment.layerWith(
          ProcessFacts.make({
            arch: process.arch,
            nodeVersion: process.version,
            pid: process.pid,
            platform: process.platform,
          }),
        ),
      ),
    )
}

export default Environment
