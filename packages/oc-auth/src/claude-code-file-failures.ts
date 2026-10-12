import { Effect, Option, Schema } from "effect"
import type { PlatformError } from "effect"
import pluginLog from "./plugin-log.ts"
import sources from "./claude-code-sources.ts"

/** The parts of a platform failure a credentials file reports or decides on. */
interface FileFailure {
  readonly cause?: unknown
  readonly message: string
}

/** A cleanup or durability step after a write, and how to report its failure. */
interface Cleanup {
  /** The config directory the credentials file is in. */
  readonly dir: string
  /** The warning a failure logs. */
  readonly event: string
  /** Errno codes that are no failure here. */
  readonly expected: readonly string[]
  /** The file or directory the step acts on. */
  readonly path: string
  /** The operation that failed, for the warning. */
  readonly step: string
}

// The errno code Node attaches to a failed file operation.
const Errno = Schema.Struct({ code: Schema.String }),
  /* The errno code of `failure`, when it carries one. */
  errnoOf = (failure: FileFailure): Option.Option<string> =>
    Schema.decodeUnknownOption(Errno)(failure.cause).pipe(
      Option.map((errno) => errno.code),
    ),
  /* The message of `failure`, with its errno code. */
  explained = (failure: FileFailure): string =>
    Option.match(errnoOf(failure), {
      onNone: () => failure.message,
      onSome: (code) => `${failure.message} (${code})`,
    }),
  /*
   * Report that `cleanup` failed with `failure`, unless its code is expected
   * there. The write has landed or failed by then, so this changes nothing
   * about its result: a warning with metadata, and the details in debug.
   */
  noteCleanup = (
    cleanup: Cleanup,
    failure: FileFailure,
  ): Effect.Effect<void> => {
    const code = errnoOf(failure),
      error = explained(failure)

    if (Option.exists(code, (found) => cleanup.expected.includes(found))) {
      return Effect.void
    }

    return pluginLog
      .warning(cleanup.event, {
        code: Option.getOrElse(code, () => "unknown"),
        source: sources.FILE_SOURCE,
        step: cleanup.step,
      })
      .pipe(
        Effect.andThen(
          pluginLog.debug(cleanup.event, {
            configDir: cleanup.dir,
            error,
            path: cleanup.path,
            step: cleanup.step,
          }),
        ),
      )
  },
  /* What `effect` produced, or none once its failure is reported per `cleanup`. */
  quietly = <Value, Requirements>(
    effect: Effect.Effect<Value, PlatformError.PlatformError, Requirements>,
    cleanup: Cleanup,
  ): Effect.Effect<Option.Option<Value>, never, Requirements> =>
    effect.pipe(
      Effect.asSome,
      Effect.catchTag("PlatformError", (failure: FileFailure) =>
        noteCleanup(cleanup, failure).pipe(Effect.as(Option.none<Value>())),
      ),
    )

/** Failed operations on a credentials file: their errno code and message, and cleanup failures reported. */
export default Object.freeze({ errnoOf, explained, quietly })
