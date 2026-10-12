/**
 * The layout check: every plugin and library is named, shaped, and wired as
 * the ADRs and `AGENTS.md` say. It prints one line per problem, naming the
 * file, and fails when it finds any. `pnpm run check:layout` runs it.
 */
import { Array as Arr, Console, Effect, Layer, Path } from "effect"
import { NodeRuntime, NodeServices } from "@effect/platform-node"
import LayoutError from "./layout-error.ts"
import layoutRules from "./layout-rules.ts"
import readSnapshot from "./read-snapshot.ts"

/* Print every problem and how many there are, then fail. */
const announce = (
    problems: readonly string[],
  ): Effect.Effect<never, LayoutError> =>
    Console.error(
      [
        ...problems,
        `The layout check found ${String(problems.length)} problems. Fix each one, then run pnpm run check:layout again.`,
      ].join("\n"),
    ).pipe(
      Effect.andThen(LayoutError.make({ message: "The layout check failed." })),
    ),
  /* Check the repository this file is in. */
  checkLayout = Effect.gen(function* checkLayout() {
    const path = yield* Path.Path,
      root = yield* path.fromFileUrl(new URL("..", import.meta.url)),
      snapshot = yield* readSnapshot.read(root)

    yield* Arr.match(layoutRules.problems(snapshot), {
      onEmpty: () => Console.log("The layout check found no problems."),
      onNonEmpty: (problems) => announce(problems),
    })
  })

NodeRuntime.runMain(
  Layer.build(NodeServices.layer).pipe(
    Effect.flatMap((services) =>
      checkLayout.pipe(Effect.provideContext(services)),
    ),
    Effect.scoped,
  ),
  { disableErrorReporting: true },
)
