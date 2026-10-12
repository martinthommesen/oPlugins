import { Effect, FileSystem, Path, Record as Rec } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { Vitest } from "@effect/vitest"
import fingerprintWriter from "./fingerprint-writer.ts"
import libraryFingerprints from "./library-fingerprints.ts"
import repository from "./git-repository.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, with the Node services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof NodeServices.layer> | Scope.Scope
  >
}

const FINGERPRINT = "packages/oc-demo/bundled-libraries.txt",
  KIT = "libs/kit/src/kit.ts",
  /* The demo plugin's fingerprint when the library's code is `text`. */
  fingerprintFor = Effect.fn("test.fingerprintFor")(function* fingerprintFor(
    text: string,
  ) {
    const fingerprints = yield* libraryFingerprints.expected({
      files: Rec.set(repository.FILES, KIT, text),
      libraries: ["kit"],
      plugins: ["oc-demo"],
    })

    return fingerprints.map((fingerprint) => fingerprint.text).join("")
  })

describe("writing the fingerprints from the working tree", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("writes each stale one, then nothing", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const fs = yield* FileSystem.FileSystem,
          path = yield* Path.Path,
          repo = yield* repository.stagedRepository(),
          rewritten = yield* fingerprintWriter.write(repo),
          settled = yield* fingerprintWriter.write(repo),
          text = yield* fs.readFileString(path.join(repo, FINGERPRINT))

        expect(rewritten).toStrictEqual([FINGERPRINT])
        expect(settled).toStrictEqual([])
        expect(text).toBe(yield* fingerprintFor("export default 1\n"))
      }),
    )
  })
})

describe("writing the fingerprints from the staged files", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("leaves out library edits that aren't staged", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const root = yield* repository.stagedRepository()

        yield* repository.put(root, KIT, "export default 2\n")
        yield* repository.git(root, ["add", KIT])
        yield* repository.put(root, KIT, "export default 3\n")
        yield* fingerprintWriter.stage(root)

        expect(yield* repository.git(root, ["show", `:${FINGERPRINT}`])).toBe(
          yield* fingerprintFor("export default 2\n"),
        )
        expect(yield* repository.git(root, ["show", `:${KIT}`])).toBe(
          "export default 2\n",
        )
      }),
    )

    it.effect("stages the fingerprints and nothing else", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const root = yield* repository.stagedRepository()

        yield* repository.put(root, KIT, "export default 2\n")
        yield* repository.put(root, "packages/oc-demo/README.md", "# Edit\n")
        yield* fingerprintWriter.stage(root)

        expect(yield* repository.git(root, ["diff", "--name-only"])).toBe(
          `${KIT}\npackages/oc-demo/README.md\n`,
        )
        expect(yield* repository.git(root, ["show", `:${FINGERPRINT}`])).toBe(
          yield* fingerprintFor("export default 1\n"),
        )
      }),
    )
  })
})
