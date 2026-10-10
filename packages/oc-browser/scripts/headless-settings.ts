import { Config, Option } from "effect"
import HOST_VERSION from "#src/host-version.ts"

const TARGET_HOST = "target",
  /* The host version asked for; unset or `target` means the one this release targets. */
  hostVersionOf = (requested: Option.Option<string>): string =>
    requested.pipe(
      Option.filter((version) => version !== TARGET_HOST),
      Option.getOrElse(() => HOST_VERSION),
    ),
  /** What this run of the smoke test does, from the variables it reads. */
  settings = Config.all({
    hostVersion: Config.option(
      Config.nonEmptyString("OBROWSE_HEADLESS_HOST_VERSION"),
    ).pipe(Config.map(hostVersionOf)),
    keep: Config.option(Config.nonEmptyString("HEADLESS_KEEP")).pipe(
      Config.map(Option.isSome),
    ),
  })

export default settings
