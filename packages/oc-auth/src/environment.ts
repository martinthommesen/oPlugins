import { Config, Context, Effect, Layer, Schema } from "effect"
import type { Option } from "effect"

const DEFAULT_SECURITY_BINARY = "/usr/bin/security",
  /** Facts about the running process, which tests replace. */
  ProcessFacts = Schema.Struct({
    /** The CPU architecture, such as `arm64`. */
    arch: Schema.String,
    /** The Node.js version, such as `v22.6.0`. */
    nodeVersion: Schema.String,
    /** The process ID. */
    pid: Schema.Finite,
    /** The operating system, such as `darwin` or `linux`. */
    platform: Schema.String,
  }),
  /* A non-empty variable, or none when it is unset or empty. */
  present = (name: string): Config.Config<Option.Option<string>> =>
    Config.option(Config.NonEmptyString(name)),
  /*
   * The variables the plugin reads, decoded once when it loads: those other
   * programs own, and two test overrides. Every setting of the plugin's own
   * is a plugin option.
   */
  variables = Config.all({
    claudeConfigDir: present("CLAUDE_CONFIG_DIR"),
    home: Config.NonEmptyString("HOME").pipe(
      Config.orElse(() => Config.NonEmptyString("USERPROFILE")),
    ),
    lockDir: present("OC_AUTH_REFRESH_LOCK_DIR"),
    securityBinary: Config.NonEmptyString("OC_AUTH_SECURITY_BIN").pipe(
      Config.withDefault(DEFAULT_SECURITY_BINARY),
    ),
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
    /** Facts about the running process. */
    readonly process: typeof ProcessFacts.Type
    /** The environment variables the plugin reads, decoded. */
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
