import { Effect, Path } from "effect"
import type { Layer, Scope } from "effect"
import { describe, expect, it as test } from "@effect/vitest"
import { NodeServices } from "@effect/platform-node"
import type { Vitest } from "@effect/vitest"
import bundling from "./bundling.test-support.ts"
import readSnapshot from "./read-snapshot.ts"
import releasePlan from "./release-plan.test-support.ts"

/** The `it` of a `test.layer` block: `it.effect`, with the Node services. */
interface Tests {
  readonly effect: Vitest.Test<
    Layer.Success<typeof NodeServices.layer> | Scope.Scope
  >
}

const FAILURE = "libs/host-failure/src/host-failure.ts",
  REDACTION = "libs/log-redaction/src/log-redaction.ts",
  /* This repository, as the checks read it. */
  repository = Effect.fn("test.repository")(function* repository() {
    const path = yield* Path.Path,
      root = yield* path.fromFileUrl(new URL("..", import.meta.url))

    return yield* readSnapshot.read(root)
  }, Effect.orDie),
  /* This repository, with every plugin last released as 1.2.3. */
  withReleases = Effect.fn("test.withReleases")(function* withReleases() {
    const layout = yield* repository(),
      versions = layout.plugins.map((folder) => `"packages/${folder}": "1.2.3"`)

    return bundling.withFile(
      layout,
      ".release-please-manifest.json",
      `{ ${versions.join(", ")} }\n`,
    )
  })

describe("release-please's plan for a library fix", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("releases exactly the plugins it's bundled into", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const base = yield* repository(),
          change = yield* releasePlan.libraryChange(
            base,
            REDACTION,
            "fix(log-redaction): redact cookies",
          )

        expect(change.files).toStrictEqual([
          REDACTION,
          "packages/oc-auth/bundled-libraries.txt",
          "packages/oc-auto/bundled-libraries.txt",
        ])
        expect(yield* releasePlan.plan(base, [change])).toStrictEqual([
          "oc-auth 0.1.1",
          "oc-auto 0.1.1",
        ])
      }),
    )

    it.effect("releases every plugin a shared library is bundled into", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const base = yield* repository(),
          change = yield* releasePlan.libraryChange(
            base,
            "libs/plugin-options/src/plugin-options.ts",
            "feat(plugin-options): name the option",
          )

        expect(yield* releasePlan.plan(base, [change])).toStrictEqual([
          "oc-advisor 0.2.0",
          "oc-auth 0.2.0",
          "oc-auto 0.2.0",
          "oc-browser 0.2.0",
          "oc-usage 0.2.0",
        ])
      }),
    )
  })
})

describe("release-please's plan for changes that release nothing", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("leaves out a test-only library's fix", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const base = yield* repository(),
          change = yield* releasePlan.libraryChange(
            base,
            "libs/captured-logs/src/captured-logs.ts",
            "fix(captured-logs): keep every record",
          )

        expect(change.files).toStrictEqual([
          "libs/captured-logs/src/captured-logs.ts",
        ])
        expect(yield* releasePlan.plan(base, [change])).toStrictEqual([])
      }),
    )

    it.effect("leaves out a library fix that left the fingerprints stale", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const base = yield* repository()

        expect(
          yield* releasePlan.plan(base, [
            { files: [REDACTION], message: "fix(log-redaction): redact" },
          ]),
        ).toStrictEqual([])
      }),
    )

    it.effect("leaves out a library refactor", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const base = yield* repository(),
          change = yield* releasePlan.libraryChange(
            base,
            REDACTION,
            "refactor(log-redaction): name the patterns",
          )

        expect(yield* releasePlan.plan(base, [change])).toStrictEqual([])
      }),
    )
  })
})

describe("release-please's plan for a fingerprint repair", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("releases nothing for a chore, and the plugin for a fix", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const base = yield* repository(),
          files = ["packages/oc-auth/bundled-libraries.txt"]

        expect(
          yield* releasePlan.plan(base, [
            { files, message: "chore: update the fingerprints" },
          ]),
        ).toStrictEqual([])
        expect(
          yield* releasePlan.plan(base, [
            { files, message: "fix(log-redaction): redact cookies" },
          ]),
        ).toStrictEqual(["oc-auth 0.1.1"])
      }),
    )
  })
})

describe("release-please's version bump for a library change", () => {
  test.layer(NodeServices.layer)((it: Tests) => {
    it.effect("follows the commit type: fix, feat, or breaking", () =>
      Effect.gen(function* run() {
        expect.hasAssertions()

        const base = yield* withReleases(),
          breaking = yield* releasePlan.libraryChange(
            base,
            FAILURE,
            "feat(host-failure)!: rename the categories",
          ),
          feature = yield* releasePlan.libraryChange(
            base,
            FAILURE,
            "feat(host-failure): name timeouts",
          ),
          fix = yield* releasePlan.libraryChange(
            base,
            FAILURE,
            "fix(host-failure): name timeouts",
          )

        expect(yield* releasePlan.plan(base, [fix])).toStrictEqual([
          "oc-advisor 1.2.4",
          "oc-auto 1.2.4",
          "oc-usage 1.2.4",
        ])
        expect(yield* releasePlan.plan(base, [feature, fix])).toStrictEqual([
          "oc-advisor 1.3.0",
          "oc-auto 1.3.0",
          "oc-usage 1.3.0",
        ])
        expect(yield* releasePlan.plan(base, [breaking])).toStrictEqual([
          "oc-advisor 2.0.0, breaking",
          "oc-auto 2.0.0, breaking",
          "oc-usage 2.0.0, breaking",
        ])
      }),
    )
  })
})
