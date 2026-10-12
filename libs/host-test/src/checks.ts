import { Effect, FileSystem } from "effect"
import HostTestError from "./host-test-error.ts"
import commands from "./command.ts"

/** The installed host, and how the host test runs it. */
interface Host {
  /** The variables that differ from the inherited environment. */
  readonly env: Readonly<Record<string, string>>
  readonly opencode: string
  readonly work: string
}

/* Whether the marker file's `text` lists `pluginId` as started. */
const listsStarted = (text: string, pluginId: string): boolean =>
    text.split("\n").includes(pluginId),
  /*
   * Check that the host starts the packed plugin as `pluginId`. `auth list`
   * makes the host start its plugins, and the wrapper appends the plugin's
   * ID to the marker file once the plugin's setup finishes. No marker file
   * means no plugin started.
   */
  pluginStarted = Effect.fn("HostTest.pluginStarted")(function* pluginStarted(
    host: Host,
    marker: string,
    pluginId: string,
  ) {
    const failure = HostTestError.make({
        message: `The host did not start ${pluginId}. Look for the plugin's error in the host log above.`,
      }),
      fs = yield* FileSystem.FileSystem,
      output = yield* commands.run({
        args: ["auth", "list", "--standalone"],
        command: host.opencode,
        cwd: host.work,
        env: host.env,
      }),
      text = yield* fs
        .readFileString(marker)
        .pipe(Effect.orElseSucceed(() => "")),
      unstarted = !listsStarted(text, pluginId)

    yield* commands
      .printError(output)
      .pipe(
        Effect.andThen(Effect.fail(failure)),
        Effect.when(Effect.succeed(unstarted)),
      )
  })

/** The checks the host test runs against the installed host. */
export default Object.freeze({ listsStarted, pluginStarted })
