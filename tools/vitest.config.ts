import { defineConfig } from "vitest/config"

/** Every test file beside the tools, run in Node. */
const config = defineConfig({
  test: {
    environment: "node",
    include: ["*.test.ts"],
  },
})

export default config
