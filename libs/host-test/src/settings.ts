import { Config, Effect, FileSystem, Option, Path, Schema } from "effect"

/** What one run of the host test reads from its variables. */
interface Inputs {
  /** The host version asked for, or none for the targeted one. */
  readonly hostVersion: Option.Option<string>
  /** Whether to keep the sandbox afterwards. */
  readonly keep: boolean
}

const HOST_TARGET = "target",
  /* The part of `@opencode/plugin`'s manifest the host test reads. */
  PluginManifest = Schema.fromJsonString(
    Schema.Struct({ version: Schema.String }),
  ),
  /* The host version asked for; unset or `target` asks for none in particular. */
  asRequested = (requested: Option.Option<string>): Option.Option<string> =>
    requested.pipe(Option.filter((version) => version !== HOST_TARGET)),
  /*
   * The targeted host version: the version of `@opencode/plugin` that the
   * plugin at `checkout` is built against, which the workspace catalog pins.
   */
  catalogVersion = Effect.fn("HostTest.catalogVersion")(
    function* catalogVersion(checkout: string) {
      const fs = yield* FileSystem.FileSystem,
        path = yield* Path.Path,
        pinned = yield* fs
          .readFileString(
            path.join(
              checkout,
              "node_modules",
              "@opencode",
              "plugin",
              "package.json",
            ),
          )
          .pipe(
            Effect.flatMap((text) => Schema.decodeEffect(PluginManifest)(text)),
          )

      return pinned.version
    },
  ),
  /* The variables the host test reads; `hostVersionVariable` picks the host. */
  inputs = (hostVersionVariable: string): Config.Config<Inputs> =>
    Config.all({
      hostVersion: Config.option(
        Config.nonEmptyString(hostVersionVariable),
      ).pipe(Config.map(asRequested)),
      keep: Config.option(Config.nonEmptyString("HEADLESS_KEEP")).pipe(
        Config.map(Option.isSome),
      ),
    }),
  /*
   * What this run of the host test does: the host version that
   * `hostVersionVariable` asks for, else the targeted one, and whether to
   * keep the sandbox.
   */
  settings = Effect.fn("HostTest.settings")(function* settings(
    hostVersionVariable: string,
    checkout: string,
  ) {
    const asked = yield* inputs(hostVersionVariable),
      hostVersion = yield* Option.match(asked.hostVersion, {
        onNone: () => catalogVersion(checkout),
        onSome: (version) => Effect.succeed(version),
      })

    return { hostVersion, keep: asked.keep }
  })

/** The host test's settings, from its variables and the workspace catalog. */
export default Object.freeze({ asRequested, read: settings })
