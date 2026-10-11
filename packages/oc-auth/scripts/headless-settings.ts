import { Config, Effect, Path, Stdio, Struct } from "effect"
import hostSettings from "@oc-lib/host-test/settings.ts"

const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5",
  OFFLINE_FLAG = "--offline",
  /** The variables the smoke test reads, beside the host test's own. */
  inputs = Config.all({
    customModel: Config.string("OC_AUTH_HEADLESS_CUSTOM_MODEL").pipe(
      Config.map((value) => value === "1"),
      Config.withDefault(false),
    ),
    /*
     * A model that requires the pinned Claude Code version and takes the
     * effort beta, so the smoke run covers what a version or beta change can
     * break.
     */
    model: Config.nonEmptyString("OC_AUTH_HEADLESS_MODEL").pipe(
      Config.withDefault(DEFAULT_MODEL),
    ),
    /** The inherited `PATH`, which the sandbox's `bin` is put in front of. */
    path: Config.string("PATH").pipe(Config.withDefault("")),
    refreshConfigDir: Config.option(
      Config.nonEmptyString("OC_AUTH_HEADLESS_REFRESH_CONFIG_DIR"),
    ),
  }),
  /*
   * What this run of the smoke test does: the variables above, the host
   * version `OC_AUTH_HEADLESS_HOST_VERSION` asks for, whether to keep the
   * sandbox, the package directory, and whether `--offline` was passed.
   */
  settings = Effect.gen(function* readSettings() {
    const args = yield* (yield* Stdio.Stdio).args,
      checkout = yield* (yield* Path.Path).fromFileUrl(
        new URL("..", import.meta.url),
      ),
      host = yield* hostSettings.read(
        "OC_AUTH_HEADLESS_HOST_VERSION",
        checkout,
      ),
      read = yield* inputs

    return Struct.assign(Struct.assign(read, host), {
      checkout,
      offline: args.includes(OFFLINE_FLAG),
    })
  })

export default settings
