import { Config, Effect, Option, Stdio, Struct } from "effect"
import HOST_VERSION from "#src/host-version.ts"

const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5",
  OFFLINE_FLAG = "--offline",
  TARGET_HOST = "target",
  /* The host version asked for; unset or `target` means the one this release targets. */
  hostVersionOf = (requested: Option.Option<string>): string =>
    requested.pipe(
      Option.filter((version) => version !== TARGET_HOST),
      Option.getOrElse(() => HOST_VERSION),
    ),
  /** The variables the smoke test reads. */
  inputs = Config.all({
    customModel: Config.string("CLAUDE_AUTH_HEADLESS_CUSTOM_MODEL").pipe(
      Config.map((value) => value === "1"),
      Config.withDefault(false),
    ),
    hostVersion: Config.option(
      Config.nonEmptyString("CLAUDE_AUTH_HEADLESS_HOST_VERSION"),
    ).pipe(Config.map(hostVersionOf)),
    keep: Config.option(Config.nonEmptyString("HEADLESS_KEEP")).pipe(
      Config.map(Option.isSome),
    ),
    /*
     * A model that requires the pinned Claude Code version and takes the
     * effort beta, so the smoke run covers what a version or beta change can
     * break.
     */
    model: Config.nonEmptyString("CLAUDE_AUTH_HEADLESS_MODEL").pipe(
      Config.withDefault(DEFAULT_MODEL),
    ),
    /** The inherited `PATH`, which the sandbox's `bin` is put in front of. */
    path: Config.string("PATH").pipe(Config.withDefault("")),
    refreshConfigDir: Config.option(
      Config.nonEmptyString("CLAUDE_AUTH_HEADLESS_REFRESH_CONFIG_DIR"),
    ),
  }),
  /*
   * What this run of the smoke test does: the variables above, and whether
   * `--offline` was passed.
   */
  settings = Effect.gen(function* readSettings() {
    const args = yield* (yield* Stdio.Stdio).args,
      read = yield* inputs

    return Struct.assign(read, { offline: args.includes(OFFLINE_FLAG) })
  })

export default settings
