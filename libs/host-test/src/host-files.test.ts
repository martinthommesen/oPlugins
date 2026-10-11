import { Option, Schema } from "effect"
import { describe, expect, it } from "@effect/vitest"
import hostFiles from "./host-files.ts"

const HostConfig = Schema.fromJsonString(
  Schema.Struct({ $schema: Schema.String, update: Schema.String }),
)

describe("the host config", () => {
  it("turns updates off and changes nothing else", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(Schema.decodeOption(HostConfig)(hostFiles.hostConfig)).toStrictEqual(
      Option.some({
        $schema: "https://opencode.ai/config.json",
        update: "disable",
      }),
    )
  })
})

describe("the plugin wrapper", () => {
  it(
    "imports the installed plugin and appends its ID to the marker",
    { timeout: 5000 },
    () => {
      expect.hasAssertions()

      const wrapper = hostFiles.pluginWrapper({
        markerPath: '/tmp/a "quoted" dir/started.txt',
        pluginUrl: "file:///tmp/install/index.js",
      })

      expect(
        wrapper.startsWith('import plugin from "file:///tmp/install/index.js"'),
      ).toBe(true)
      expect(wrapper).toContain(
        String.raw`appendFileSync("/tmp/a \"quoted\" dir/started.txt", plugin.id + "\n")`,
      )
    },
  )

  it("is what the host's plugin file re-exports", { timeout: 5000 }, () => {
    expect.hasAssertions()
    expect(hostFiles.pluginEntry("file:///tmp/install/wrapper.js")).toBe(
      'export { default } from "file:///tmp/install/wrapper.js"\n',
    )
  })
})
