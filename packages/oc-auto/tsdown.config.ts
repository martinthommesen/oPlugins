import { defineConfig } from "tsdown"

/**
 * How oc-auto is bundled: its own code and the libraries it uses go in, and
 * every package stays external, limited to the ones it may import at run
 * time.
 */
export default defineConfig({
  // The bundle carries OpenAI Codex's Apache-2.0 policy text, and with it its license and notice.
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
