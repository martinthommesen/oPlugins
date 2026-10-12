import { Effect, FileSystem } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { Vitest } from "@effect/vitest"
import demo from "./demo-repository.test-support.ts"
import readSnapshot from "./read-snapshot.ts"

/** The `it` of a `test.layer` block: `it.effect`, on the real file system. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof NodeServices.layer> | Scope.Scope
  >
}

type Fault = ReturnType<typeof demo.denied>

type Operation = Fault["operation"]

const INDEX = "packages/oc-demo/src/index.ts",
  SOURCES = "packages/oc-demo/src",
  WORKSPACE = "pnpm-workspace.yaml",
  /* Read the demo repository, with `faults` in its file system. */
  readWith = Effect.fn("test.readWith")(function* readWith(
    faults: readonly Fault[],
  ) {
    const fs = yield* demo.faulty(faults),
      root = yield* demo.demoRepository()

    return yield* readSnapshot
      .read(root)
      .pipe(Effect.provideService(FileSystem.FileSystem, fs))
  }),
  /* The message for `path`, which `operation` couldn't read. */
  unreadable = (operation: Operation, path: string): string =>
    `${path}: The layout check can't read it: FileSystem.${operation}: permission denied. Make it readable, then run pnpm run check:layout again.`

describe("reading a readable repository", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("reads every file, at a folder's top level and below", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const snapshot = yield* readWith([])

        expect(Object.keys(snapshot.files).toSorted()).toStrictEqual([
          "libs/kit/package.json",
          "libs/kit/src/kit.ts",
          "packages/oc-demo/package.json",
          INDEX,
          WORKSPACE,
          "tools/check.ts",
        ])
        expect(snapshot.libraries).toStrictEqual(["kit"])
        expect(snapshot.plugins).toStrictEqual(["oc-demo"])
      }),
    )
  })
})

describe("reading a repository without its optional files", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("leaves them out", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const snapshot = yield* readWith([])

        expect(
          Object.hasOwn(snapshot.files, ".release-please-manifest.json"),
        ).toBe(false)
        expect(
          Object.hasOwn(
            snapshot.files,
            "packages/oc-demo/node_modules/@opencode/plugin/package.json",
          ),
        ).toBe(false)
      }),
    )
  })
})

describe("reading a repository with an unreadable file", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("fails on a file it can't read, naming it and why", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const failure = yield* readWith([
          demo.denied("readFileString", INDEX),
        ]).pipe(Effect.flip)

        expect(failure.message).toBe(unreadable("readFileString", INDEX))
      }),
    )
  })
})

describe("reading a repository with an unreadable folder", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("fails on a folder it can't read, naming it and why", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const failure = yield* readWith([
          demo.denied("readDirectory", SOURCES),
        ]).pipe(Effect.flip)

        expect(failure.message).toBe(unreadable("readDirectory", SOURCES))
      }),
    )

    it.effect("fails on an entry whose kind it can't tell", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const failure = yield* readWith([demo.denied("stat", INDEX)]).pipe(
          Effect.flip,
        )

        expect(failure.message).toBe(unreadable("stat", INDEX))
      }),
    )
  })
})

describe("reading a repository with an unreadable optional file", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("fails on an optional file that exists but can't be read", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const failure = yield* readWith([
          demo.denied("readFileString", WORKSPACE),
        ]).pipe(Effect.flip)

        expect(failure.message).toBe(unreadable("readFileString", WORKSPACE))
      }),
    )
  })
})
