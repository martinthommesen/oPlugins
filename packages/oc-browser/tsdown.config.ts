import { defineConfig } from "tsdown"

/**
 * How oc-browser is bundled. The plugin bundles its own code and the
 * libraries it uses, and leaves every package external; the build fails if
 * it imports a package outside `onlyImport`. The extension runs in Chrome,
 * where it can import no package, so it bundles everything.
 */
export default defineConfig([
  {
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
  },
  {
    clean: false,
    deps: { alwaysBundle: ["effect"], onlyImport: [] },
    dts: false,
    entry: { "service-worker": "extension/service-worker.ts" },
    fixedExtension: false,
    format: "esm",
    outDir: "dist/extension",
    platform: "browser",
    sourcemap: true,
    target: "chrome120",
    tsconfig: "extension/tsconfig.json",
  },
])
