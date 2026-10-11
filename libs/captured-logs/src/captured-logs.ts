import {
  Array as Arr,
  Context,
  Effect,
  Layer,
  Logger,
  MutableRef,
  References,
  Schema,
  SchemaTransformation,
} from "effect"
import type { Fiber, LogLevel } from "effect"

/* A logger receives a message as its parts; a record joins them. */
const Joined = SchemaTransformation.transform({
    decode: (parts: readonly string[]) => parts.join(" "),
    encode: (text: string): readonly string[] => [text],
  }),
  /** One record a plugin logged: its level, its event, and its annotations. */
  LogRecord = Schema.Struct({
    annotations: Schema.Record(Schema.String, Schema.Json),
    level: Schema.String,
    message: Schema.Array(Schema.String).pipe(
      Schema.decodeTo(Schema.String, Joined),
    ),
  }),
  LogRecords = Schema.Array(LogRecord)

/**
 * A plugin's log for tests: a logger that keeps every record, at every
 * level, for inspection, in place of the default console logger.
 */
class CapturedLogs extends Context.Service<
  CapturedLogs,
  {
    /** The records logged so far for `event`, oldest first. */
    readonly named: (
      event: string,
    ) => Effect.Effect<readonly (typeof LogRecord.Type)[]>
    /** Every record logged so far, oldest first. */
    readonly records: Effect.Effect<readonly (typeof LogRecord.Type)[]>
  }
>()("@oc-lib/captured-logs/captured-logs/CapturedLogs") {
  /** Captures every record, and provides this service to read them. */
  public static readonly layer: Layer.Layer<CapturedLogs> = Layer.unwrap(
    Effect.sync(() => {
      const kept = MutableRef.make<readonly unknown[]>([]),
        logger = Logger.make(
          (options: {
            readonly fiber: Fiber.Fiber<unknown, unknown>
            readonly logLevel: LogLevel.LogLevel
            readonly message: unknown
          }) => {
            MutableRef.update(kept, (records) => [
              ...records,
              {
                annotations: options.fiber.getRef(
                  References.CurrentLogAnnotations,
                ),
                level: options.logLevel,
                message: Arr.ensure(options.message),
              },
            ])
          },
        ),
        // A record that is not plain JSON fails the test that reads it.
        records = Effect.sync(() => MutableRef.get(kept)).pipe(
          Effect.flatMap((logged) =>
            Schema.decodeUnknownEffect(LogRecords)(logged),
          ),
          Effect.orDie,
        )

      return Layer.mergeAll(
        Layer.succeed(
          CapturedLogs,
          CapturedLogs.of({
            named: (event) =>
              records.pipe(
                Effect.map((all) =>
                  all.filter((record) => record.message === event),
                ),
              ),
            records,
          }),
        ),
        Logger.layer([logger]),
        Layer.succeed(References.MinimumLogLevel, "All"),
      )
    }),
  )
}

export default CapturedLogs
