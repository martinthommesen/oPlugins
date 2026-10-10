import { Effect, FileSystem } from "effect"
import HeadlessSmokeError from "./headless-smoke-error.ts"
import commands from "./headless-command.ts"
import plugin from "#src/index.ts"

/** The installed host, and how the smoke test runs it. */
interface Host {
  /** The variables that differ from the inherited environment. */
  readonly env: Readonly<Record<string, string>>
  readonly opencode: string
  readonly work: string
}

/*
 * The host starts the packed plugin: a command that activates plugins
 * leaves the plugin's ID in the marker file the wrapper writes once the
 * plugin's set-up has finished.
 */
const pluginStarted = Effect.fn("Headless.pluginStarted")(function* started(
  host: Host,
  marker: string,
) {
  const fs = yield* FileSystem.FileSystem,
    output = yield* commands.run({
      args: ["auth", "list", "--standalone"],
      command: host.opencode,
      cwd: host.work,
      env: host.env,
    }),
    text = yield* fs.readFileString(marker).pipe(Effect.orElseSucceed(() => ""))

  if (!text.split("\n").includes(plugin.id)) {
    yield* commands.printError(output)
    yield* new HeadlessSmokeError({
      message: `The host did not start ${plugin.id}`,
    })
  }
})

/** The checks the smoke test runs against the installed host. */
export default Object.freeze({ pluginStarted })
