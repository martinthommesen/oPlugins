import {
  Context,
  DateTime,
  Effect,
  FileSystem,
  HashSet,
  Layer,
  Option,
  Ref,
  Stdio,
  Stream,
} from "effect"
import type Environment from "./environment.ts"
import type { Path } from "effect"
import debugLogFile from "./debug-log-file.ts"
import redact from "./log-redaction.ts"

type LogFields = typeof redact extends (fields: infer Fields) => object
  ? Fields
  : never

type Warning = LogFields & { readonly warning: string }

/** The mutable state one logger owns for the plugin's lifetime. */
interface LogState {
  /** The open log file, or none when logging is off or has failed. */
  readonly sink: Ref.Ref<Option.Option<string>>
  /** Events already reported on stderr. */
  readonly warned: Ref.Ref<HashSet.HashSet<string>>
}

const WARNING_PREFIX = "oBrowse: ",
  /* Write `text` to stderr. Nowhere is left to report a failure to. */
  alert = Effect.fn("DebugLog.alert")(function* alert(text: string) {
    const stdio = yield* Stdio.Stdio

    yield* Stream.make(`${WARNING_PREFIX}${text}\n`).pipe(
      Stream.run(stdio.stderr()),
      Effect.ignore,
    )
  }),
  /*
   * Report `message` on stderr once per event per plugin lifetime. The
   * service outlives any one request, and a warning repeated on every
   * request would bury everything else it prints.
   */
  announce = (
    state: LogState,
    event: string,
    message: string,
  ): Effect.Effect<void, never, Stdio.Stdio> =>
    alert(message).pipe(
      Effect.when(
        Ref.modify(state.warned, (seen) => [
          !HashSet.has(seen, event),
          HashSet.add(seen, event),
        ]),
      ),
      Effect.asVoid,
    ),
  /* One JSON line from its fields, in order. */
  encodeLine = (
    entries: readonly (readonly [string, LogFields[string]])[],
  ): string => `${JSON.stringify(Object.fromEntries(entries))}\n`,
  /* One JSON line: timestamp, event, then the redacted fields. */
  formatRecord = (event: string, fields: LogFields): Effect.Effect<string> => {
    const entries = Object.entries(redact(fields))

    return DateTime.now.pipe(
      Effect.map(DateTime.formatIso),
      Effect.map((ts) =>
        encodeLine([["ts", ts], ["event", event], ...entries]),
      ),
    )
  },
  /*
   * Append one record. A full disk must not turn a successful action into
   * a failure, but a log that silently stops is worse than one that says it
   * stopped.
   */
  logTo = Effect.fn("DebugLog.log")(function* logTo(
    state: LogState,
    event: string,
    fields: LogFields,
  ) {
    const disable = (failure: {
        readonly message: string
      }): Effect.Effect<void, never, Stdio.Stdio> =>
        Ref.set(state.sink, Option.none()).pipe(
          Effect.andThen(
            announce(
              state,
              "log_write_failed",
              `debug log disabled: ${failure.message}`,
            ),
          ),
        ),
      fs = yield* FileSystem.FileSystem,
      line = yield* formatRecord(event, fields),
      sink = yield* Ref.get(state.sink)

    yield* Option.match(sink, {
      onNone: () => Effect.void,
      onSome: (path) =>
        fs
          .writeFileString(path, line, { flag: "a" })
          .pipe(Effect.catchTag("PlatformError", disable)),
    })
  }),
  /*
   * The log file to write, prepared, or none. A rejected `OBROWSE_DEBUG`
   * must not take the plugin down with it, and there is no log to report it
   * to yet, so it goes to stderr.
   */
  openSink: Effect.Effect<
    Option.Option<string>,
    never,
    Environment | FileSystem.FileSystem | Path.Path | Stdio.Stdio
  > = debugLogFile.resolveLogPath().pipe(
    Effect.tap(
      Option.match({
        onNone: () => Effect.void,
        onSome: debugLogFile.startLog,
      }),
    ),
    Effect.catchTags({
      DebugLogPathError: (failure: { readonly message: string }) =>
        alert(failure.message).pipe(Effect.as(Option.none<string>())),
      PlatformError: (failure: { readonly message: string }) =>
        alert(failure.message).pipe(Effect.as(Option.none<string>())),
    }),
  ),
  /*
   * Report a problem the user has to act on. The debug log is off by
   * default, so the warning also goes to stderr, once per event. Warnings
   * must not carry secrets; the other fields go only to the redacted log.
   */
  warnTo = (
    state: LogState,
    event: string,
    fields: Warning,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Stdio.Stdio> =>
    logTo(state, event, fields).pipe(
      Effect.andThen(announce(state, event, fields.warning)),
    )

/**
 * The plugin's debug log. Records go to the file `OBROWSE_DEBUG` names
 * (`1` picks one in OpenCode's data directory) and nowhere when it is unset.
 * Warnings also reach stderr.
 */
class DebugLog extends Context.Service<
  DebugLog,
  {
    readonly log: (event: string, fields: LogFields) => Effect.Effect<void>
    readonly warn: (event: string, fields: Warning) => Effect.Effect<void>
  }
>()("obrowse/debug-log/DebugLog") {
  /** The live logger. */
  public static readonly layer: Layer.Layer<
    DebugLog,
    never,
    Environment | FileSystem.FileSystem | Path.Path | Stdio.Stdio
  > = Layer.effect(
    DebugLog,
    Effect.gen(function* makeDebugLog() {
      const context = yield* Effect.context<
          FileSystem.FileSystem | Stdio.Stdio
        >(),
        state: LogState = {
          sink: yield* Ref.make(yield* openSink),
          warned: yield* Ref.make(HashSet.empty<string>()),
        }

      return DebugLog.of({
        log: (event, fields) =>
          logTo(state, event, fields).pipe(Effect.provideContext(context)),
        warn: (event, fields) =>
          warnTo(state, event, fields).pipe(Effect.provideContext(context)),
      })
    }),
  )
}

export default DebugLog
