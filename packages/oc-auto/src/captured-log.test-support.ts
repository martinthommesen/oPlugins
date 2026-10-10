import { Effect, Layer, Logger, References, Schema } from "effect"
import { TestConsole } from "effect/testing"

/** Log records as the capturing logger keeps them, oldest first. */
const LogRecords = Schema.Array(
    Schema.Struct({
      annotations: Schema.Record(Schema.String, Schema.Json),
      level: Schema.String,
      message: Schema.String,
    }),
  ),
  /*
   * A logger that keeps every record, at every level, for the test to read,
   * in place of the host's log.
   */
  layer = Layer.mergeAll(
    Logger.layer([Logger.consoleStructured]),
    TestConsole.layer,
    Layer.succeed(References.MinimumLogLevel, "All"),
  ),
  /* Every record logged so far, with its level and annotations. */
  records = TestConsole.logLines.pipe(
    Effect.flatMap((lines) => Schema.decodeUnknownEffect(LogRecords)(lines)),
  )

/** A capturing logger for tests, and the records it kept. */
export default Object.freeze({ layer, records })
