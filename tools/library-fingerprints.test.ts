import { Array as Arr, Effect, pipe } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { Vitest } from "@effect/vitest"
import bundling from "./bundling.test-support.ts"
import libraryFingerprints from "./library-fingerprints.ts"

/** The `it` of a `test.layer` block: `it.effect`, with the Node services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof NodeServices.layer> | Scope.Scope
  >
}

type Fingerprint = Effect.Success<
  ReturnType<typeof libraryFingerprints.expected>
>[number]

type Layout = typeof bundling.LAYOUT

const DIGEST = /^[a-z]+ [0-9a-f]{64}$/u,
  DIGEST_FIELD = / [0-9a-f]{64}$/u,
  ONE = "packages/oc-one/bundled-libraries.txt",
  /* The plugins whose fingerprint differs between `before` and `after`. */
  changedBetween = Effect.fn("test.changedBetween")(function* changedBetween(
    before: Layout,
    after: Layout,
  ) {
    const [earlier, later] = yield* pipe(
      [before, after],
      Effect.forEach((layout) => libraryFingerprints.expected(layout)),
    )

    return Arr.zip(earlier ?? [], later ?? [])
      .filter(
        ([left, right]: readonly [Fingerprint, Fingerprint]) =>
          left.text !== right.text,
      )
      .map(([left]: readonly [Fingerprint, Fingerprint]) => left.plugin)
  }),
  /* The plugins whose fingerprint changes when `file` holds `text`. */
  changedBy = Effect.fn("test.changedBy")(function* changedBy(
    file: string,
    text: string,
  ) {
    return yield* changedBetween(
      bundling.LAYOUT,
      bundling.withFile(bundling.LAYOUT, file, text),
    )
  }),
  /* The layout with every plugin's fingerprint file as it should read. */
  current = Effect.fn("test.current")(function* current() {
    const fingerprints = yield* libraryFingerprints.expected(bundling.LAYOUT)

    return {
      files: Object.fromEntries([
        ...Object.entries(bundling.LAYOUT.files),
        ...fingerprints.map(
          (fingerprint) => [fingerprint.file, fingerprint.text] as const,
        ),
      ]),
      libraries: bundling.LAYOUT.libraries,
      plugins: bundling.LAYOUT.plugins,
    }
  })

describe("a bundled library's change", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("changes each plugin it's bundled into, and only those", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* changedBy("libs/shared/src/shared.ts", "export default 4\n"),
        ).toStrictEqual(["oc-one", "oc-two"])
        expect(
          yield* changedBy("libs/shared/package.json", "{}\n"),
        ).toStrictEqual(["oc-one", "oc-two"])
      }),
    )

    it.effect("reaches plugins through the library that imports it", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* changedBy("libs/deep/src/deep.ts", "export default 5\n"),
        ).toStrictEqual(["oc-one", "oc-two"])
      }),
    )
  })
})

describe("a change outside the bundles", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("changes no fingerprint", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* changedBy("libs/testkit/src/testkit.ts", "export default 6\n"),
        ).toStrictEqual([])
        expect(
          yield* changedBy("libs/shared/src/shared.test.ts", "// Changed.\n"),
        ).toStrictEqual([])
        expect(
          yield* changedBy("libs/shared/AGENTS.md", "# Changed\n"),
        ).toStrictEqual([])
        expect(
          yield* changedBy("libs/typed/src/typed.ts", "export type Kind = 1\n"),
        ).toStrictEqual([])
      }),
    )
  })
})

describe("a plugin's fingerprint file", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("lists each bundled library with its digest", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const layout = yield* current(),
          lines = (layout.files[ONE] ?? "")
            .split("\n")
            .filter((line) => DIGEST.test(line))
            .map((line) => line.replace(DIGEST_FIELD, ""))

        expect(lines).toStrictEqual(["deep", "shared"])
        expect(yield* changedBetween(layout, yield* current())).toStrictEqual(
          [],
        )
      }),
    )
  })
})

describe("the fingerprint check", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("passes when every fingerprint is current", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()
        expect(
          yield* libraryFingerprints.problems(yield* current()),
        ).toStrictEqual([])
      }),
    )

    it.effect("names a stale plugin and the command that fixes it", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const layout = bundling.withFile(yield* current(), ONE, "# Old.\n")

        expect(yield* libraryFingerprints.problems(layout)).toStrictEqual([
          `${ONE}: The fingerprint of the libraries bundled into oc-one is stale. Run pnpm run fingerprints, then commit it with the library change, so release-please releases oc-one.`,
        ])
      }),
    )

    it.effect("names a plugin whose fingerprint is missing", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const problems = yield* libraryFingerprints.problems(bundling.LAYOUT)

        expect(problems).toContain(
          `${ONE}: The fingerprint of the libraries bundled into oc-one is missing. Run pnpm run fingerprints, then commit it, so a change to a library bundled into oc-one releases oc-one.`,
        )
      }),
    )
  })
})
