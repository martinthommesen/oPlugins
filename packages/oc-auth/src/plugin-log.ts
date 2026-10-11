import { Effect, Predicate } from "effect"
import redact from "@oc-lib/log-redaction/log-redaction.ts"

type Fields = typeof redact extends (fields: infer Value) => object
  ? Value
  : never

/**
 * What a warning may carry: metadata such as event names, ids, sources,
 * counts, sizes, durations, status codes, model ids, and booleans. Never
 * content such as messages, paths, or anything a credential holds.
 */
type Metadata = Readonly<Record<string, boolean | number | string>>

/* `fields` with every secret removed and absent values dropped. */
const annotationsOf = (fields: Fields): Fields =>
    Object.fromEntries(
      Object.entries(redact(fields)).filter(
        ([, value]: readonly [string, Fields[string]]) =>
          !Predicate.isUndefined(value),
      ),
    ),
  /*
   * Log `event` at debug level with `fields`. A debug record may carry
   * content such as an error message or a file path, so every field passes
   * through redaction first.
   */
  debug = (event: string, fields: Fields): Effect.Effect<void> =>
    Effect.logDebug(event).pipe(Effect.annotateLogs(annotationsOf(fields))),
  /*
   * Log `event` as a warning carrying `metadata` only. Content that explains
   * it, such as an error message, goes in a separate debug record.
   */
  warning = (event: string, metadata: Metadata): Effect.Effect<void> =>
    Effect.logWarning(event).pipe(Effect.annotateLogs(metadata))

/**
 * The plugin's log records, written through Effect's logger to the host's
 * log. Each record's message is its event's stable snake_case name.
 */
export default Object.freeze({ debug, warning })
