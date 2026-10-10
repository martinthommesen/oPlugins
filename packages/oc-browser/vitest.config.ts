import { defineConfig } from "vitest/config"

/** Every test file under `src` and `extension`, run in Node. */
const config = defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "extension/**/*.test.ts"],
  },
})

export default config
