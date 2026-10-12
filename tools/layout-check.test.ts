import { Effect, Exit, FileSystem, Path, Ref, Stdio } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { Vitest } from "@effect/vitest"
import demo from "./demo-repository.test-support.ts"
import layoutCheck from "./layout-check.ts"

/** The `it` of a `test.layer` block: `it.effect`, on the real file system. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof NodeServices.layer> | Scope.Scope
  >
}

type Fault = ReturnType<typeof demo.denied>

const INDEX = "packages/oc-demo/src/index.ts",
  /*
   * Check the demo repository, with `faults` in its file system. Succeeds
   * with what the check printed to stderr and whether it failed.
   */
  checkWith = Effect.fn("test.checkWith")(function* checkWith(
    faults: readonly Fault[],
  ) {
    const fs = yield* demo.faulty(faults),
      path = yield* Path.Path,
      printed = yield* Ref.make(""),
      root = yield* demo.demoRepository(),
      url = yield* path.toFileUrl(root),
      verdict = yield* layoutCheck
        .main(url.href)
        .pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Stdio.Stdio, demo.printingTo(printed)),
          Effect.exit,
        )

    return { failed: Exit.isFailure(verdict), stderr: yield* Ref.get(printed) }
  })

describe("the layout check's report", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("prints the layout problems once, without a cause", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const report = yield* checkWith([])

        expect(report.failed).toBe(true)
        expect(report.stderr).toMatch(
          /The layout check found \d+ problems\. Fix each one, then run pnpm run check:layout again\.\n$/u,
        )
        expect(report.stderr).not.toContain("LayoutError")
      }),
    )

    it.effect("prints an unreadable file once, then fails", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const report = yield* checkWith([demo.denied("readFileString", INDEX)])

        expect(report.failed).toBe(true)
        expect(report.stderr).toBe(
          `${INDEX}: The layout check can't read it: FileSystem.readFileString: permission denied. Make it readable, then run pnpm run check:layout again.\n`,
        )
      }),
    )

    it.effect("prints the cause of an unexpected failure", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const report = yield* checkWith([
          {
            failure: Effect.die("the disk is on fire"),
            operation: "readDirectory",
            path: "libs",
          },
        ])

        expect(report.failed).toBe(true)
        expect(report.stderr).toContain("the disk is on fire")
      }),
    )
  })
})
