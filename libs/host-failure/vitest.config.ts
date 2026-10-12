import { defineConfig } from "vitest/config"

/** Every test file under `src`, run in Node. */
const config = defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})

export default config
