import { describe, expect, it } from "@effect/vitest"
import { Struct } from "effect"
import layout from "./layout.test-support.ts"
import pluginManifestRules from "./plugin-manifest-rules.ts"

/** New values for some of the manifest's fields. */
type Changes = Readonly<Record<string, Readonly<Record<string, string>>>>

const FILE = "packages/oc-demo/package.json",
  /* The problems in oc-demo's manifest with `changes` applied. */
  problemsWith = (changes: Changes): readonly string[] => {
    const text = JSON.stringify(Struct.assign(layout.MANIFEST, changes))

    return pluginManifestRules.problems(
      layout.withFile(layout.MANIFEST_FILE, text),
      "oc-demo",
    )
  }

describe("a plugin's exports", () => {
  it("include the server plugin's bundle", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({ exports: { "./tui": "./dist/tui.js" } }),
    ).toStrictEqual([
      `${FILE}: "exports" lacks ".": "./dist/index.js". Add it.`,
    ])
  })

  it(
    "include the CLI plugin's bundle when it has one",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()
      expect(
        problemsWith({ exports: { ".": "./dist/index.js" } }),
      ).toStrictEqual([
        `${FILE}: "exports" lacks "./tui": "./dist/tui.js", but src/tui.ts exists. Add it.`,
      ])
    },
  )

  it("leave out a CLI plugin it doesn't have", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      pluginManifestRules.problems(
        layout.withoutFile("packages/oc-demo/src/tui.ts"),
        "oc-demo",
      ),
    ).toStrictEqual([
      `${FILE}: "exports" has "./tui", but src/tui.ts doesn't exist. Remove it.`,
    ])
  })
})

describe("a plugin's engines", () => {
  it("give the oldest supported host as >=X.Y.Z", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({ engines: { node: ">=26", opencode: "^2.0.26" } }),
    ).toStrictEqual([
      `${FILE}: "engines.node" is set, but the host decides the Node version. Remove it.`,
      `${FILE}: "engines.opencode" is "^2.0.26". Set it to the oldest supported OpenCode version, such as ">=2.0.26".`,
    ])
  })
})

describe("a plugin's scripts", () => {
  it("include every script a plugin runs", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({
        scripts: Struct.omit(layout.MANIFEST.scripts, ["test:host"]),
      }),
    ).toStrictEqual([`${FILE}: The "test:host" script is missing. Add it.`])
  })
})

describe("a plugin's library dependencies", () => {
  it("are devDependencies", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({ dependencies: { "@oc-lib/demo-kit": "workspace:*" } }),
    ).toStrictEqual([
      `${FILE}: "@oc-lib/demo-kit" is in "dependencies". Move it to "devDependencies", because the plugin's bundle includes the library.`,
    ])
  })

  it("come from the workspace", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({
        devDependencies: { "@oc-lib/demo-kit": "^0.1.0", effect: "catalog:" },
      }),
    ).toStrictEqual([
      `${FILE}: devDependencies "@oc-lib/demo-kit" is "^0.1.0". Set it to "workspace:*".`,
    ])
  })
})

describe("a plugin's other dependencies", () => {
  it("come from the catalog", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({ devDependencies: { effect: "4.0.0-rc.112" } }),
    ).toStrictEqual([
      `${FILE}: devDependencies "effect" is "4.0.0-rc.112". Set it to "catalog:", and pin the version in the catalog in pnpm-workspace.yaml.`,
    ])
  })

  it("are ranges when they're peers", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({ peerDependencies: { effect: "catalog:" } }),
    ).toStrictEqual([
      `${FILE}: peerDependencies "effect" is "catalog:". Set it to a version range, such as ">=1.0.0".`,
    ])
  })
})
