import { describe, expect, it } from "@effect/vitest"
import layout from "./layout.test-support.ts"
import pluginFileRules from "./plugin-file-rules.ts"

const DEMO = "packages/oc-demo",
  /* The file problems of oc-demo with `file` holding `text`. */
  problemsWith = (file: string, text: string): readonly string[] =>
    pluginFileRules.problems(layout.withFile(file, text), "oc-demo")

describe("a plugin's folder", () => {
  it("passes when it has every file", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(pluginFileRules.problems(layout.VALID, "oc-demo")).toStrictEqual([])
  })

  it("is the plugin name", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      pluginFileRules
        .problems(layout.VALID, "demo-plugin")
        .filter((problem) => problem.startsWith("packages/demo-plugin: ")),
    ).toStrictEqual([
      "packages/demo-plugin: The folder name doesn't match ^oc-[a-z]+$. Rename the plugin to oc-<word>, as ADR 0003 says.",
    ])
  })

  it("has every required file", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      pluginFileRules.problems(
        layout.withoutFile(`${DEMO}/scripts/test-host.ts`),
        "oc-demo",
      ),
    ).toStrictEqual([
      `${DEMO}/scripts/test-host.ts: The file is missing. Add it.`,
    ])
  })

  it("is MIT licensed", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(problemsWith(`${DEMO}/LICENSE`, "ISC License\n")).toStrictEqual([
      `${DEMO}/LICENSE: The license isn't the MIT License. Use the MIT License text, as every plugin does.`,
    ])
  })
})

describe("a plugin's IDs", () => {
  it("name the server plugin after the plugin", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith(`${DEMO}/src/index.ts`, 'export default { id: "demo" }\n'),
    ).toStrictEqual([
      `${DEMO}/src/index.ts: The plugin ID "martinthommesen.oc-demo" is missing. Set the plugin's id to "martinthommesen.oc-demo".`,
    ])
  })

  it("name the CLI plugin after the plugin", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith(
        `${DEMO}/src/tui.ts`,
        'export default { id: "martinthommesen.oc-demo" }\n',
      ),
    ).toStrictEqual([
      `${DEMO}/src/tui.ts: The plugin ID "martinthommesen.oc-demo.cli" is missing. Set the plugin's id to "martinthommesen.oc-demo.cli".`,
    ])
  })
})

describe("a plugin's environment variables", () => {
  it("start with the plugin's prefix", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith(
        `${DEMO}/src/environment.ts`,
        ["const own = 'OC_DEMO_DIR',", '  other = "OC_AUTH_DIR"', ""].join(
          "\n",
        ),
      ),
    ).toStrictEqual([
      `${DEMO}/src/environment.ts:2: "OC_AUTH_DIR" doesn't start with OC_DEMO_. Rename it so it starts with the plugin's prefix, OC_DEMO_.`,
    ])
  })

  it("aren't read from comments", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith(
        `${DEMO}/scripts/settings.ts`,
        "/* Set `OC_AUTH_DIR` to move it. */\nconst url = `https://x/OC_X`\n",
      ),
    ).toStrictEqual([])
  })

  it("are checked in src and scripts only", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(
      problemsWith(`${DEMO}/extension/worker.ts`, 'const name = "OC_AUTH_DIR"'),
    ).toStrictEqual([])
  })
})
