import { defineConfig } from "tsdown"

/**
 * How oc-usage is bundled: its own code and the libraries it uses go in, and
 * every package stays external, limited to the ones it may import at run
 * time.
 */
export default defineConfig({
  deps: {
    alwaysBundle: [/^@oc-lib\//u],
    neverBundle: true,
    onlyImport: ["@opencode/plugin", "@opentui/solid", "effect", "solid-js"],
  },
  dts: false,
  entry: { index: "src/index.ts", tui: "src/tui.ts" },
  fixedExtension: false,
  format: "esm",
  platform: "node",
  sourcemap: true,
  target: "es2023",
})
