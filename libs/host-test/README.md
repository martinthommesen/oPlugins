# @oc-lib/host-test

The headless host test every plugin runs with `pnpm run test:host`. It packs the
plugin and installs it with a given OpenCode CLI into a temporary sandbox. The
sandbox has its own config, data, cache, and state directories. The test then
checks that the host starts the plugin.

This private library is never published and never part of a plugin bundle.
Plugins use it from `scripts/` only, as a devDependency
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

- `npmName` gives the installed entry, `node_modules/<npmName>/dist/index.js`,
  and the sandbox's name.
- `pluginId` is the ID the host must start that entry under.
- `hostVersionVariable` names the environment variable that picks the host
  version. Unset or `target`, it asks for the version of `@opencode/plugin` the
  plugin is built against, which the workspace catalog pins. `oldest` asks for
  the oldest version the plugin supports, which its `package.json` records as
  `engines.opencode` (`>=X.Y.Z`). Any other value is the version to install.
- `HEADLESS_KEEP`, when set, keeps the sandbox afterwards.

## Building blocks

A plugin with checks of its own, such as oc-auth, builds its test from the
modules `host-test.ts` uses:

| Module               | Provides                                                          |
| -------------------- | ----------------------------------------------------------------- |
| `settings.ts`        | `read`: the host version and `HEADLESS_KEEP`                      |
| `sandbox.ts`         | `acquire`, `furnish`, `layout`, `environment`: the scoped sandbox |
| `install.ts`         | `host`, `plugin`: the CLI and the packed plugin                   |
| `host-files.ts`      | `pluginWrapper`, `pluginEntry`, `hostConfig`: the host's files    |
| `checks.ts`          | `pluginStarted`                                                   |
| `command.ts`         | `run`, `printError`                                               |
| `host-test-error.ts` | `HostTestError`, the failure of any step                          |

When the test fails, it prints the sandbox's host log before it removes the
sandbox.

## Command deadline

`command.ts`'s `run` gives each command 180 seconds to exit and close its stdout
and stderr. A descendant that holds an output stream open after the command
exits counts against the same deadline. After the deadline, cleanup has a
bounded allowance of 10 seconds:

- Stopping the command gets 5 seconds: SIGTERM to its process group, then
  SIGKILL after a 3-second grace.
- Releasing the process gets 5 seconds. A release that takes longer keeps
  running detached, so it cannot hold the test.

A command that times out therefore fails within 190 seconds of starting, with
its timeout and the output it gave so far. When stopping it failed or did not
finish, the failure says so instead of claiming the command stopped.
