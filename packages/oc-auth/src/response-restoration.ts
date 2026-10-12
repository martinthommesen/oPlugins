import { Array as Arr, Effect, Option, Order, Stream } from "effect"
import responseToolNames from "./response-tool-names.ts"

/** Maps each alias this plugin applied back to the OpenCode tool name. */
type OriginalByAlias = Readonly<Record<string, string>>

/*
 * The SSE spec ends an event with a blank line and allows CRLF, LF, or CR
 * line ends.
 */
const BLANK_LINES = ["\r\n\r\n", "\n\n", "\r\r"],
  BOUNDARY_SLACK = 1,
  /** One less than the longest boundary: the most that can straddle a chunk edge. */
  CARRY =
    Math.max(...BLANK_LINES.map((boundary) => boundary.length)) -
    BOUNDARY_SLACK,
  DATA_FIELD = "data:",
  /** Just past a line end that ends a blank line: the end of an SSE event. */
  EVENT_END = /(?<=(?:\r\n|\n|\r(?!\n)){2})/u,
  /** Just past any line end, so each line keeps its own. */
  LINE_END = /(?<=\n|\r(?!\n))/u,
  LINE_TERMINATOR = /(?:\r\n|\n|\r)$/u,
  NOT_FOUND = -1,
  START = 0,
  TEXTUAL_TYPES = ["event-stream", "json"],
  TEXT_PREFIX = "text/",
  VALUE_SPACE = /^ /u,
  /* `line` without its line end. */
  bareLine = (line: string): string => line.replace(LINE_TERMINATOR, ""),
  /* Whether `line` is a `data` field, part of its event's payload. */
  carriesData = (line: string): boolean => line.startsWith(DATA_FIELD),
  /*
   * An event's `lines` with its payload replaced by `data`, written on the
   * line its payload started on, with that line's own line end.
   */
  dataReplaced = (lines: readonly string[], data: string): string => {
    const first = lines.findIndex((line) => carriesData(line))

    return lines
      .map((line, index) => {
        if (!carriesData(line)) {
          return line
        }

        if (index !== first) {
          return ""
        }

        return `${DATA_FIELD} ${data}${line.slice(bareLine(line).length)}`
      })
      .join("")
  },
  /* The value of a `data` line: after the field name and one optional space. */
  dataValue = (line: string): string =>
    bareLine(line).slice(DATA_FIELD.length).replace(VALUE_SPACE, ""),
  /*
   * One SSE event with its tool names restored. An event whose payload is
   * not JSON, or names no tool of ours, passes byte for byte.
   */
  eventRestored = (event: string, originalByAlias: OriginalByAlias): string => {
    const lines = event.split(LINE_END),
      payload = lines
        .filter((line) => carriesData(line))
        .map((line) => dataValue(line))
        .join("\n")

    return Option.match(responseToolNames.inEvent(payload, originalByAlias), {
      onNone: () => event,
      onSome: (data) => dataReplaced(lines, data),
    })
  },
  /* Complete SSE events with their tool names restored, one event at a time. */
  eventsRestored = (text: string, originalByAlias: OriginalByAlias): string =>
    text
      .split(EVENT_END)
      .map((event) => eventRestored(event, originalByAlias))
      .join(""),
  /*
   * Whether a response body is text this plugin may decode. Rewriting runs
   * through TextDecoder, which replaces every invalid byte with U+FFFD, so a
   * binary body a proxy returned must pass through untouched.
   */
  isTextualBody = (response: Response): boolean =>
    Option.fromNullishOr(response.headers.get("content-type")).pipe(
      Option.filter((type) => type !== ""),
      Option.map((type) => type.toLowerCase()),
      Option.match({
        onNone: () => true,
        onSome: (type) =>
          TEXTUAL_TYPES.some((textual) => type.includes(textual)) ||
          type.startsWith(TEXT_PREFIX),
      }),
    ),
  /*
   * Index just past the last SSE event boundary in `buffer`, or none.
   *
   * `from` is the length the buffer had before the newest chunk. Everything
   * below it was already searched and found boundary-free, so the scan starts
   * just far enough back to catch a boundary split across the chunk edge.
   * Without that, a body with no framing rescans everything received so far
   * on every chunk, which is quadratic in the body size.
   */
  lastEventBoundary = (buffer: string, from: number): Option.Option<number> => {
    const offset = Math.max(START, from - CARRY),
      rest = buffer.slice(offset),
      stops = BLANK_LINES.flatMap((boundary) => {
        const index = rest.lastIndexOf(boundary)

        if (index === NOT_FOUND) {
          return []
        }

        return [offset + index + boundary.length]
      })

    return Option.liftPredicate(stops, Arr.isArrayNonEmpty).pipe(
      Option.map(Arr.max(Order.Number)),
    )
  },
  /*
   * The text left when the body ends, with its tool names restored: a whole
   * JSON message, or else the last events of a stream.
   */
  lastRestored = (text: string, originalByAlias: OriginalByAlias): string =>
    Option.getOrElse(responseToolNames.inMessage(text, originalByAlias), () =>
      eventsRestored(text, originalByAlias),
    ),
  /*
   * `body` as text with the original tool names restored, flushed on SSE
   * event boundaries so each event is rewritten whole and passes on as soon
   * as it is complete. A body without event boundaries, such as a
   * non-streaming JSON response, is rewritten whole when the stream ends.
   * The caller reads such a body whole anyway, so holding it costs one more
   * copy.
   */
  namesRestored = (
    body: ReadableStream<Uint8Array>,
    originalByAlias: OriginalByAlias,
  ): Stream.Stream<string, unknown> =>
    Stream.suspend(() => {
      const decoder = new TextDecoder()

      return Stream.fromReadableStream({
        evaluate: () => body,
        onError: (cause) => cause,
      }).pipe(
        Stream.mapAccum(
          () => "",
          (pending: string, chunk: Uint8Array) => {
            const buffer = `${pending}${decoder.decode(chunk, { stream: true })}`

            return Option.match(lastEventBoundary(buffer, pending.length), {
              onNone: (): readonly [string, readonly string[]] => [buffer, []],
              onSome: (boundary): readonly [string, readonly string[]] => [
                buffer.slice(boundary),
                [
                  eventsRestored(
                    buffer.slice(START, boundary),
                    originalByAlias,
                  ),
                ],
              ],
            })
          },
          {
            onHalt: (pending: string): readonly string[] =>
              Arr.filter(
                [`${pending}${decoder.decode()}`],
                (rest) => rest !== "",
              ).map((rest) => lastRestored(rest, originalByAlias)),
          },
        ),
      )
    }),
  /*
   * Restore original tool names in the response body so OpenCode sees the
   * tools it registered. A response with nothing to restore, or with a body
   * that is not text, is returned as it came.
   */
  restoreResponse = (
    response: Response,
    originalByAlias: OriginalByAlias,
  ): Effect.Effect<Response> =>
    Option.fromNullishOr(response.body).pipe(
      Option.filter(
        () =>
          Object.keys(originalByAlias).length > START &&
          isTextualBody(response),
      ),
      Option.match({
        onNone: () => Effect.succeed(response),
        onSome: (body) =>
          namesRestored(body, originalByAlias).pipe(
            Stream.encodeText,
            Stream.toReadableStreamEffect(),
            Effect.map((restored) => {
              const headers = new Headers(response.headers)

              headers.delete("content-length")

              return new Response(restored, {
                headers,
                status: response.status,
                statusText: response.statusText,
              })
            }),
          ),
      }),
    )

/** Restoring OpenCode's tool names in a response from the API. */
export default Object.freeze({ restore: restoreResponse })
