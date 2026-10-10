import { Config, Context, Effect, Layer, Schema } from "effect"
import type { Option } from "effect"

/* Facts about the running process, which tests replace. */
const ProcessFacts = Schema.Struct({ platform: Schema.String }),
  // A non-empty variable, or none when it is unset or empty.
  present = (name: string): Config.Config<Option.Option<string>> =>
    Config.option(Config.nonEmptyString(name)),
  /** Variables the plugin reads, decoded once when it loads. */
  variables = Config.all({
    debug: present("OBROWSE_DEBUG"),
    home: Config.nonEmptyString("HOME").pipe(
      Config.orElse(() => Config.nonEmptyString("USERPROFILE")),
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
    readonly process: typeof ProcessFacts.Type
    readonly variables: Config.Success<typeof variables>
  }
>()("@martinthommesen/oc-browser/environment") {
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
          ProcessFacts.make({ platform: process.platform }),
        ),
      ),
    )
}

export default Environment
