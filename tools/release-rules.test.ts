import { describe, expect, it } from "@effect/vitest"
import layout from "./layout.test-support.ts"
import releaseRules from "./release-rules.ts"

const CONFIG = "release-please-config.json",
  MANIFEST = ".release-please-manifest.json"

describe("the release-please config", () => {
  it("passes when it lists exactly the plugins", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(releaseRules.problems(layout.VALID)).toStrictEqual([])
  })

  it("lists every plugin and nothing else", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const config = JSON.stringify({ packages: { "libs/demo-kit": {} } })

    expect(
      releaseRules.problems(layout.withFile(CONFIG, config)),
    ).toStrictEqual([
      `${CONFIG}: It doesn't list the plugin packages/oc-demo. Add it, so release-please releases the plugin.`,
      `${CONFIG}: It lists libs/demo-kit, which isn't a plugin. Remove it.`,
    ])
  })

  it("names each plugin's component and package", { timeout: 5000 }, () => {
    expect.hasAssertions()

    const config = JSON.stringify({
      packages: { "packages/oc-demo": { component: "demo" } },
    })

    expect(
      releaseRules.problems(layout.withFile(CONFIG, config)),
    ).toStrictEqual([
      `${CONFIG}: packages/oc-demo has "component" "demo". Set it to "oc-demo".`,
      `${CONFIG}: packages/oc-demo has "package-name" missing. Set it to "@martinthommesen/oc-demo".`,
    ])
  })
})

describe("the release-please manifest", () => {
  it("lists every plugin", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      releaseRules.problems(layout.withFile(MANIFEST, "{}")),
    ).toStrictEqual([
      `${MANIFEST}: It doesn't list the plugin packages/oc-demo. Add it, so release-please releases the plugin.`,
    ])
  })

  it("is there", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(releaseRules.problems(layout.withoutFile(MANIFEST))).toStrictEqual([
      `${MANIFEST}: The file is missing. Add it.`,
    ])
  })
})
