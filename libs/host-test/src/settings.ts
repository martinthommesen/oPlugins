import { Config, Data, Effect, FileSystem, Option, Path, Schema } from "effect"
import HostTestError from "./host-test-error.ts"

/** Which host version a run asks for. */
type HostRequest = Data.TaggedEnum<{
  /** One version, as given. */
  Exact: { readonly version: string }
  /** The oldest version the plugin supports: its `engines.opencode`. */
  Oldest: object
  /** The version the plugin is built against: the catalog's `@opencode/plugin`. */
  Target: object
}>

/** What one run of the host test reads from its variables. */
interface Inputs {
  readonly hostVersion: HostRequest
  /** Whether to keep the sandbox afterwards. */
  readonly keep: boolean
}

const HOST_OLDEST = "oldest",
  HOST_TARGET = "target",
  /** The form of an `engines.opencode` that gives the oldest supported host. */
  OLDEST_RANGE = /^>=\d+\.\d+\.\d+$/u,
  OLDEST_RANGE_PREFIX = ">=",
  /** The part of the plugin's own manifest the host test reads. */
  OwnManifest = Schema.fromJsonString(
    Schema.Struct({ engines: Schema.Struct({ opencode: Schema.String }) }),
  ),
  /** The part of `@opencode/plugin`'s manifest the host test reads. */
  PluginManifest = Schema.fromJsonString(
    Schema.Struct({ version: Schema.String }),
  ),
  Requested = Data.taggedEnum<HostRequest>(),
  /*
   * The host version asked for: unset or `target` asks for the targeted
   * one, `oldest` for the oldest the plugin supports, and anything else for
   * that version.
   */
  asRequested = (requested: Option.Option<string>): HostRequest => {
    const version = Option.getOrElse(requested, () => HOST_TARGET)

    if (version === HOST_TARGET) {
      return Requested.Target()
    }

    if (version === HOST_OLDEST) {
      return Requested.Oldest()
    }

    return Requested.Exact({ version })
  },
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
        Config.NonEmptyString(hostVersionVariable),
      ).pipe(Config.map(asRequested)),
      keep: Config.option(Config.NonEmptyString("HEADLESS_KEEP")).pipe(
        Config.map(Option.isSome),
      ),
    }),
  /* The version in `range`, an `engines.opencode` of the form `>=X.Y.Z`. */
  oldestOf = (range: string): Option.Option<string> => {
    if (!OLDEST_RANGE.test(range)) {
      return Option.none()
    }

    return Option.some(range.slice(OLDEST_RANGE_PREFIX.length))
  },
  /*
   * The oldest host version the plugin at `checkout` supports: the one its
   * `package.json` gives as `engines.opencode`, `>=X.Y.Z`.
   */
  oldestVersion = Effect.fn("HostTest.oldestVersion")(function* oldestVersion(
    checkout: string,
  ) {
    const failure = HostTestError.make({
        message:
          'The plugin\'s package.json gives no oldest OpenCode version. Set "engines.opencode" to ">=X.Y.Z", the oldest version the plugin supports.',
      }),
      fs = yield* FileSystem.FileSystem,
      path = yield* Path.Path,
      stated = yield* fs
        .readFileString(path.join(checkout, "package.json"))
        .pipe(
          Effect.flatMap((text) => Schema.decodeEffect(OwnManifest)(text)),
          Effect.mapError(() => failure),
        )

    return yield* Effect.fromOption(oldestOf(stated.engines.opencode)).pipe(
      Effect.mapError(() => failure),
    )
  }),
  /*
   * What this run of the host test does: the host version that
   * `hostVersionVariable` asks for, the targeted one when it asks for none,
   * and whether to keep the sandbox.
   */
  settings = Effect.fn("HostTest.settings")(function* settings(
    hostVersionVariable: string,
    checkout: string,
  ) {
    const asked = yield* inputs(hostVersionVariable),
      hostVersion = yield* Requested.$match(asked.hostVersion, {
        Exact: (exact) => Effect.succeed(exact.version),
        Oldest: () => oldestVersion(checkout),
        Target: () => catalogVersion(checkout),
      })

    return { hostVersion, keep: asked.keep }
  })

/**
 * The host test's settings, from its variables, the plugin's manifest, and
 * the workspace catalog. The request constructors have lowercase names here
 * because `new-cap` accepts a PascalCase call only on a PascalCase owner.
 */
export default Object.freeze({
  asRequested,
  exact: Requested.Exact,
  oldest: Requested.Oldest,
  oldestOf,
  read: settings,
  target: Requested.Target,
})
