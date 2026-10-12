# @oc-lib/host-test

A private, dev-only library: the headless host test each plugin runs with
`pnpm run test:host`. It packs the plugin, installs it with a given OpenCode CLI
in a sandbox, and checks that the host starts it.

- Import each module by its file, such as `@oc-lib/host-test/host-test.ts`, and
  only from a plugin's `scripts/`, so it stays out of the plugin's bundle. A
  plugin depends on it as a devDependency, `"@oc-lib/host-test": "workspace:*"`.
- Scripts run its TypeScript source with `node --experimental-strip-types`.
- A plugin's `OC_<WORD>_HEADLESS_HOST_VERSION` picks the host: `target`, the
  default, `oldest`, or an exact version. `oldest` reads the plugin's
  `engines.opencode`, the one place the plugin records its oldest supported
  host.
- The host test downloads OpenCode, so `pnpm run check` runs only this library's
  unit tests; CI runs each plugin's `test:host`.
- Read `README.md` before you write or change a plugin's host test: it shows a
  whole test and the modules it's built from.
