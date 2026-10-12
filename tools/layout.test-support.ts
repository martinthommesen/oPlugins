import { Record as Rec } from "effect"
import type Snapshot from "./snapshot.ts"

type Layout = typeof Snapshot.Type

const DEMO = "packages/oc-demo",
  /** The installed `@opencode/plugin` manifest, which pins effect. */
  HOST_MANIFEST = JSON.stringify({
    dependencies: { effect: "4.0.0-rc.112" },
    version: "2.0.26",
  }),
  /** A valid plugin manifest, for oc-demo. */
  MANIFEST = {
    author: "Maintainer <maintainer@example.com>",
    devDependencies: {
      "@oc-lib/demo-kit": "workspace:*",
      effect: "catalog:",
    },
    engines: { opencode: ">=2.0.26" },
    exports: { ".": "./dist/index.js", "./tui": "./dist/tui.js" },
    files: ["dist"],
    keywords: ["opencode", "plugin"],
    license: "MIT",
    name: "@martinthommesen/oc-demo",
    peerDependencies: { effect: "^4.0.0-rc.112" },
    repository: {
      directory: "packages/oc-demo",
      type: "git",
      url: "git+https://github.com/martinthommesen/oc-plugins.git",
    },
    scripts: {
      build: "tsdown",
      "lint:effect": "effect-tsgo diagnostics --project tsconfig.json",
      prepublishOnly: "pnpm run build",
      test: "vitest run",
      "test:host": "node scripts/test-host.ts",
      typecheck: "tsc -p tsconfig.json",
      "verify:dist": "node -e ''",
    },
    type: "module",
    version: "0.1.0",
  },
  MANIFEST_FILE = `${DEMO}/package.json`,
  /** The release action, pinned to a commit. */
  RELEASE_ACTION =
    "googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7",
  /** A release workflow that records the action and what it bundles. */
  RELEASE_WORKFLOW = [
    "jobs:",
    "  release-please:",
    "    env:",
    `      RELEASE_PLEASE_ACTION: ${RELEASE_ACTION}`,
    "      RELEASE_PLEASE_VERSION: 17.6.0",
    "    steps:",
    `      - uses: ${RELEASE_ACTION}`,
    "",
  ].join("\n"),
  /** A repository with one valid plugin, oc-demo, and one library. */
  VALID: Layout = {
    files: {
      ".github/workflows/release.yml": RELEASE_WORKFLOW,
      ".release-please-manifest.json": JSON.stringify({ [DEMO]: "0.1.0" }),
      [`${DEMO}/AGENTS.md`]: "# oc-demo\n",
      [`${DEMO}/LICENSE`]: "MIT License\n\nCopyright (c) 2026 Maintainer\n",
      [`${DEMO}/README.md`]: "# oc-demo\n",
      [`${DEMO}/node_modules/@opencode/plugin/package.json`]: HOST_MANIFEST,
      [MANIFEST_FILE]: JSON.stringify(MANIFEST),
      [`${DEMO}/scripts/test-host.ts`]:
        'const variable = "OC_DEMO_HEADLESS_HOST_VERSION"\n',
      [`${DEMO}/src/index.ts`]:
        'export default { id: "martinthommesen.oc-demo" }\n',
      [`${DEMO}/src/tui.ts`]:
        'export default { id: "martinthommesen.oc-demo.cli" }\n',
      [`${DEMO}/tsconfig.json`]: "{}\n",
      [`${DEMO}/tsdown.config.ts`]: "export default {}\n",
      [`${DEMO}/vitest.config.ts`]: "export default {}\n",
      "libs/demo-kit/AGENTS.md": "# demo-kit\n",
      "libs/demo-kit/package.json": JSON.stringify({
        name: "@oc-lib/demo-kit",
        private: true,
        scripts: { "lint:effect": "x", test: "x", typecheck: "x" },
      }),
      "pnpm-workspace.yaml": [
        "catalog:",
        '  "@effect/vitest": 4.0.0-rc.112',
        '  "@opencode/plugin": 2.0.26',
        "  effect: 4.0.0-rc.112",
        "",
      ].join("\n"),
      "release-please-config.json": JSON.stringify({
        packages: {
          [DEMO]: {
            component: "oc-demo",
            "package-name": "@martinthommesen/oc-demo",
          },
        },
      }),
      "tools/package.json": JSON.stringify({
        devDependencies: { "release-please": "17.6.0" },
      }),
    },
    libraries: ["demo-kit"],
    plugins: ["oc-demo"],
  },
  /* The valid repository, with `file` holding `text`. */
  withFile = (file: string, text: string): Layout => ({
    files: Rec.set(VALID.files, file, text),
    libraries: VALID.libraries,
    plugins: VALID.plugins,
  }),
  /* The valid repository, without `file`. */
  withoutFile = (file: string): Layout => ({
    files: Rec.remove(VALID.files, file),
    libraries: VALID.libraries,
    plugins: VALID.plugins,
  })

/** A valid repository for the layout check, and ways to break it. */
export default Object.freeze({
  MANIFEST,
  MANIFEST_FILE,
  RELEASE_ACTION,
  RELEASE_WORKFLOW,
  VALID,
  withFile,
  withoutFile,
})
