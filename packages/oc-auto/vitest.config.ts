import { defineConfig } from "vitest/config"

/** Every test file under `src`. */
export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
  },
})
