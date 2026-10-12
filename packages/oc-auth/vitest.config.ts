import { defineConfig } from "vitest/config"

/**
 * Every test file under `src`, run in Node. The CLI plugin's tests mount its
 * sidebar section in OpenTUI's test renderer, which loads its native library
 * through `node:ffi`, available behind `--experimental-ffi`. `@opentui/solid`
 * imports Solid's reactive build by its file, while bare `solid-js` resolves
 * to Solid's server build in Node, which never updates; the alias gives the
 * plugin the same reactive build.
 */
const config = defineConfig({
  resolve: {
    alias: [{ find: /^solid-js$/u, replacement: "solid-js/dist/solid.js" }],
  },
  test: {
    environment: "node",
    execArgv: ["--experimental-ffi"],
    include: ["src/**/*.test.ts"],
  },
})

export default config
