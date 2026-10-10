import { Context, Effect, Layer, Ref, Sink, Stdio, Stream } from "effect"

const decoder = new TextDecoder(),
  /* A chunk written to stderr, as text. */
  textOf = (chunk: string | Uint8Array): string => {
    if (chunk instanceof Uint8Array) {
      return decoder.decode(chunk)
    }

    return chunk
  }

/** Stderr for tests: a `Stdio` whose stderr writes are kept for inspection. */
class CapturedStderr extends Context.Service<
  CapturedStderr,
  { readonly text: Effect.Effect<string> }
>()("@martinthommesen/oc-auth/captured-stderr.test-support/CapturedStderr") {
  /** Provides `Stdio` with captured stderr, and this service to read it. */
  public static readonly layer: Layer.Layer<CapturedStderr | Stdio.Stdio> =
    Layer.effectContext(
      Effect.gen(function* captureStderr() {
        const buffer = yield* Ref.make(""),
          stdio = Stdio.make({
            args: Effect.succeed([]),
            stderr: () =>
              Sink.forEachArray((chunks: readonly (string | Uint8Array)[]) =>
                Ref.update(buffer, (text) =>
                  [text, ...chunks.map((chunk) => textOf(chunk))].join(""),
                ),
              ),
            stdin: Stream.empty,
            stdout: () => Sink.drain,
          })

        return Context.make(CapturedStderr, { text: Ref.get(buffer) }).pipe(
          Context.add(Stdio.Stdio, stdio),
        )
      }),
    )
}

export default CapturedStderr
