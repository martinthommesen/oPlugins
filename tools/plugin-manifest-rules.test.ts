import { describe, expect, it } from "@effect/vitest"
import { Struct } from "effect"
import layout from "./layout.test-support.ts"
import pluginManifestRules from "./plugin-manifest-rules.ts"

/** New values for some of the manifest's fields. */
type Changes = Readonly<
  Record<
    string,
    boolean | string | readonly string[] | Readonly<Record<string, string>>
  >
>

const FILE = "packages/oc-demo/package.json",
  /* The problems in oc-demo's manifest when its text is `text`. */
  problemsOf = (text: string): readonly string[] =>
    pluginManifestRules.problems(
      layout.withFile(layout.MANIFEST_FILE, text),
      "oc-demo",
    ),
  /* The problems in oc-demo's manifest with `changes` applied. */
  problemsWith = (changes: Changes): readonly string[] =>
    problemsOf(JSON.stringify(Struct.assign(layout.MANIFEST, changes))),
  /* The problems in oc-demo's manifest without the fields `fields`. */
  problemsWithout = (
    fields: readonly (keyof typeof layout.MANIFEST)[],
  ): readonly string[] =>
    problemsOf(JSON.stringify(Struct.omit(layout.MANIFEST, fields)))

describe("a plugin's identity", () => {
  it("passes when it follows the plugin name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(pluginManifestRules.problems(layout.VALID, "oc-demo")).toStrictEqual(
      [],
    )
  })

  it("has the npm name the plugin name gives", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWith({ name: "oc-demo" })).toStrictEqual([
      `${FILE}: "name" is "oc-demo". Set it to "@martinthommesen/oc-demo".`,
    ])
  })

  it("has a semver version and the MIT license", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWith({ license: "ISC", version: "1.0" })).toStrictEqual([
      `${FILE}: "version" is "1.0", which isn't a semver version. Set it to one, such as "0.1.0".`,
      `${FILE}: "license" is "ISC". Set it to "MIT".`,
    ])
  })

  it("has an author", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWithout(["author"])).toStrictEqual([
      `${FILE}: "author" is missing. Set it to the maintainer.`,
    ])
  })
})

describe("a plugin's package", () => {
  it("is an ES module that holds only dist", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({ files: ["dist", "src"], type: "commonjs" }),
    ).toStrictEqual([
      `${FILE}: "type" is "commonjs". Set it to "module".`,
      `${FILE}: "files" isn't ["dist"]. Set it to ["dist"], so the package holds only the bundle.`,
    ])
  })

  it("isn't private", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWith({ private: true })).toStrictEqual([
      `${FILE}: "private" is set, but a plugin is published. Remove it.`,
    ])
  })

  it("has the opencode keyword", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWith({ keywords: ["plugin"] })).toStrictEqual([
      `${FILE}: "keywords" lacks "opencode". Add it.`,
    ])
  })
})

describe("a plugin's repository", () => {
  it("is its folder in oc-plugins", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith({
        repository: { type: "git", url: "https://example.com/x.git" },
      }),
    ).toStrictEqual([
      `${FILE}: "repository" doesn't point at packages/oc-demo in oc-plugins. Set it to { "type": "git", "url": "git+https://github.com/martinthommesen/oc-plugins.git", "directory": "packages/oc-demo" }.`,
    ])
  })
})

describe("an unreadable plugin manifest", () => {
  it("is one problem", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsOf("{").map((problem) =>
        problem.startsWith(`${FILE}: The checks can't read the file:`),
      ),
    ).toStrictEqual([true])
  })

  it("is missing", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      pluginManifestRules.problems(
        layout.withoutFile(layout.MANIFEST_FILE),
        "oc-demo",
      ),
    ).toStrictEqual([`${FILE}: The file is missing. Add it.`])
  })
})
