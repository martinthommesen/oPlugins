/**
 * Writes each plugin's fingerprint of the libraries bundled into it.
 * `pnpm run fingerprints` writes them from the working tree. The pre-commit
 * hook's `pnpm run fingerprints:staged` writes them from the staged files,
 * then stages them and nothing else.
 */
import { Effect, Layer, Path, Stdio, Stream } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import fingerprintWriter from "./fingerprint-writer.ts"

const STAGED = "--staged",
  /* Whether to write from the staged files, or from the working tree. */
  pick = (
    staged: boolean,
  ): typeof fingerprintWriter.stage | typeof fingerprintWriter.write => {
    if (staged) {
      return fingerprintWriter.stage
    }

    return fingerprintWriter.write
  },
  /* Print the fingerprints that `changed` lists, and how many there are. */
  report = Effect.fn("Fingerprints.report")(function* report(
    changed: readonly string[],
  ) {
    const lines = changed.map((file) => `Updated ${file}`),
      stdio = yield* Stdio.Stdio

    yield* Stream.make(
      `${[...lines, `${String(lines.length)} fingerprints changed.`].join("\n")}\n`,
    ).pipe(Stream.run(stdio.stdout()))
  }),
  /* Write the fingerprints of the repository at the file URL `rootUrl`. */
  run = Effect.fn("Fingerprints.run")(function* run(rootUrl: string) {
    const io = yield* Stdio.Stdio,
      path = yield* Path.Path,
      root = yield* path.fromFileUrl(new URL(rootUrl)),
      switches = yield* io.args,
      written = yield* pick(switches.includes(STAGED))(root)

    yield* report(written)
  })

NodeRuntime.runMain(
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((services) =>
      run(new URL("..", import.meta.url).href).pipe(
        Effect.provideContext(services),
      ),
    ),
    Effect.scoped,
  ),
)
