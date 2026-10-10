import { Array as Arr, Effect, Option, Order, Stream } from "effect"
import toolAliases from "./tool-aliases.ts"

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
  NOT_FOUND = -1,
  START = 0,
  TEXTUAL_TYPES = ["event-stream", "json"],
  TEXT_PREFIX = "text/",
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
   * `body` as text with the original tool names restored, flushed on SSE
   * event boundaries so a tool name is never split across two rewrites. A
   * body without event boundaries, such as a non-streaming JSON response, is
   * rewritten whole when the stream ends. The caller reads such a body whole
   * anyway, so holding it costs one more copy.
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
                  toolAliases.restore(
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
              ).map((rest) => toolAliases.restore(rest, originalByAlias)),
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
