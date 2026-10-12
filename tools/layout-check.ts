import {
  Array as Arr,
  Cause,
  Effect,
  Option,
  Path,
  Schema,
  Stdio,
  Stream,
} from "effect"
import LayoutError from "./layout-error.ts"
import type { PlatformError } from "effect"
import layoutRules from "./layout-rules.ts"
import libraryFingerprints from "./library-fingerprints.ts"
import readSnapshot from "./read-snapshot.ts"

const FAILED = "The layout check failed.",
  /* Write `text` and a line break to stdout. */
  affirm = Effect.fn("Layout.affirm")(function* affirm(text: string) {
    const stdio = yield* Stdio.Stdio

    yield* Stream.make(`${text}\n`).pipe(Stream.run(stdio.stdout()))
  }),
  /* Write `text` and a line break to stderr. */
  alert = Effect.fn("Layout.alert")(function* alert(text: string) {
    const stdio = yield* Stdio.Stdio

    yield* Stream.make(`${text}\n`).pipe(Stream.run(stdio.stderr()))
  }),
  /* Print every problem and how many there are, then fail. */
  announce = (
    problems: readonly string[],
  ): Effect.Effect<
    never,
    LayoutError | PlatformError.PlatformError,
    Stdio.Stdio
  > =>
    alert(
      [
        ...problems,
        `The layout check found ${String(problems.length)} problems. Fix each one, then run pnpm run check:layout again.`,
      ].join("\n"),
    ).pipe(Effect.andThen(LayoutError.make({ message: FAILED }))),
  /* Check the repository at `root`, its plugins' fingerprints included. */
  check = Effect.fn("Layout.check")(function* check(root: string) {
    const snapshot = yield* readSnapshot.read(root),
      stale = yield* libraryFingerprints.problems(snapshot)

    yield* Arr.match([...layoutRules.problems(snapshot), ...stale], {
      onEmpty: () => affirm("The layout check found no problems."),
      onNonEmpty: (problems) => announce(problems),
    })
  }),
  /* Whether `cause` is a layout failure the check has already printed. */
  isReported = <Failure>(cause: Cause.Cause<Failure>): boolean =>
    !Cause.hasDies(cause) &&
    Option.exists(Cause.findErrorOption(cause), (failure) =>
      Schema.is(LayoutError)(failure),
    ),
  /* Print `cause` unless the check has already printed it. */
  logCause = <Failure>(
    cause: Cause.Cause<Failure>,
  ): Effect.Effect<void, PlatformError.PlatformError, Stdio.Stdio> => {
    if (isReported(cause)) {
      return Effect.void
    }

    return alert(Cause.pretty(cause))
  },
  /*
   * Check the repository at the file URL `rootUrl`. It prints each problem,
   * or why it couldn't read the repository, and fails. Any other failure
   * prints its cause.
   */
  main = Effect.fn("Layout.main")(
    function* main(rootUrl: string) {
      const path = yield* Path.Path,
        root = yield* path.fromFileUrl(new URL(rootUrl))

      yield* check(root)
    },
    Effect.catchTag(
      "LayoutReadError",
      (failure: { readonly message: string }) =>
        alert(failure.message).pipe(
          Effect.andThen(LayoutError.make({ message: FAILED })),
        ),
    ),
    Effect.tapCause((cause) => logCause(cause)),
  )

/** The layout check, as a program that reports what it finds. */
export default Object.freeze({ main })
