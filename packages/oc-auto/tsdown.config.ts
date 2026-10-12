import { defineConfig } from "tsdown"

/**
 * How oc-auto is bundled. The bundle holds the plugin's own code and the
 * libraries it uses. Every package stays external, and the bundle may import
 * only `effect` at run time.
 */
export default defineConfig({
  // The bundle includes Apache-2.0 policy text from OpenAI Codex, so its license and notice ship too.
  copy: {
    from: ["src/vendor/codex/LICENSE", "src/vendor/codex/NOTICE"],
    to: "dist/vendor/codex",
  },
  deps: {
    alwaysBundle: [/^@oc-lib\//u],
    neverBundle: true,
    onlyImport: ["effect"],
  },
  dts: false,
  entry: { index: "src/index.ts" },
  fixedExtension: false,
  format: "esm",
  platform: "node",
  sourcemap: true,
  target: "es2023",
})
