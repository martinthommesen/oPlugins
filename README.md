# oc-plugins

OpenCode v2 plugins, one package each.

## Development

Requires Node 26 and pnpm 12.

```sh
pnpm install
pnpm run check
```

`check` runs lint, format check, typecheck, Effect diagnostics, and tests for
every package, then builds and packs every plugin and runs publint, knip,
sherif, and the layout check. `pnpm run secrets` scans for secrets with gitleaks
(`brew install gitleaks`). See `AGENTS.md` for the policy behind them.

## Plugins

| Plugin     | npm name                      | Published |
| ---------- | ----------------------------- | --------- |
| oc-advisor | `@martinthommesen/oc-advisor` | Not yet   |
| oc-auth    | `@martinthommesen/oc-auth`    | Not yet   |
| oc-auto    | `@martinthommesen/oc-auto`    | Not yet   |
| oc-browser | `@martinthommesen/oc-browser` | Not yet   |

Each plugin lives in `packages/<plugin name>`.

## Releasing

release-please runs in manifest mode (`release-please-config.json`,
`.release-please-manifest.json`) and releases each plugin on its own, with its
own pull request and tagged `<plugin name>-v<version>`. While a plugin is below
1.0, a breaking change bumps the minor version.

Publishing isn't set up yet. `release.yml` publishes with npm trusted
publishing, which needs no token, but npm lets you configure it only for a
package that already exists. To set up publishing for a plugin:

1. Publish its first version, 0.1.0, by hand, and tag it `<plugin name>-v0.1.0`.
2. Shortly before its next release, add the trusted publisher on npmjs.com: user
   `martinthommesen`, repository `oc-plugins`, workflow `release.yml`. A new
   trusted publisher expires unless a publish uses it within 48 hours.
3. Set the plugin's repository variable, such as `OC_AUTH_NPM_PUBLISH`, to
   `true`. Until you do, `release.yml` skips the plugin's publish step.
