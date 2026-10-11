# @oc-lib/host-test

The headless host test every plugin runs with `pnpm run test:host`: it packs
the plugin, installs it with a given OpenCode CLI into a temporary sandbox
with its own config, data, cache, and state directories, and checks that the
host starts it. A private library: never published, and never part of a
plugin bundle. Plugins use it from `scripts/` only, as a devDependency
(`"@oc-lib/host-test": "workspace:*"`).

Scripts run its TypeScript source with `node --experimental-strip-types`, so
each module is imported by its file: `@oc-lib/host-test/<module>.ts`.

## A plugin's host test

`host-test.ts` is the whole test for a plugin that only needs to start:

```ts
import { NodeRuntime } from "@effect/platform-node"
import hostTest from "@oc-lib/host-test/host-test.ts"

NodeRuntime.runMain(
  hostTest.main({
    hostVersionVariable: "OC_BROWSER_HEADLESS_HOST_VERSION",
    npmName: "@martinthommesen/oc-browser",
    packageUrl: new URL("..", import.meta.url).href,
    pluginId: "martinthommesen.oc-browser",
  }),
)
```

- `npmName` gives the installed entry,
  `node_modules/<npmName>/dist/index.js`, and the sandbox's name.
- `pluginId` is the ID the host must start that entry under.
- `hostVersionVariable` picks the host version. Unset or `target`, it is the
  version of `@opencode/plugin` the plugin is built against, which the
  workspace catalog pins. `oldest` is the oldest version the plugin
  supports, which its `package.json` records as `engines.opencode`
  (`>=X.Y.Z`). Any other value is the version to install.
  `HEADLESS_KEEP` keeps the sandbox afterwards.

## Building blocks

A plugin with checks of its own, such as oc-auth, builds its test from the
modules `host-test.ts` uses:

| Module               | Provides                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `settings.ts`        | `read`: the host version and `HEADLESS_KEEP`                      |
| `sandbox.ts`         | `acquire`, `furnish`, `layout`, `environment`: the scoped sandbox |
| `install.ts`         | `host`, `plugin`: the CLI and the packed plugin                   |
| `host-files.ts`      | The plugin wrapper that reports a start, and the host config      |
| `checks.ts`          | `pluginStarted`                                                   |
| `command.ts`         | `run`, `printError`                                               |
| `host-test-error.ts` | `HostTestError`, the failure of any check                         |

On failure the sandbox's host log is printed before the sandbox is removed.
