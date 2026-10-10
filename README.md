# oc-plugins

OpenCode v2 plugins, one package each.

## Development

Requires Node 26 and pnpm 12.

```sh
pnpm install
pnpm run check
```

`check` runs lint, format check, typecheck, Effect diagnostics, and tests
for every package. See `AGENTS.md` for the policy behind them.

## Plugins

| Plugin       | npm name                      | Published |
| ------------ | ----------------------------- | --------- |
| `oc-advisor` | `@martinthommesen/oc-advisor` | Not yet   |
| `oc-auth`    | `@martinthommesen/oc-auth`    | Not yet   |
| `oc-auto`    | `@martinthommesen/oc-auto`    | Not yet   |
| `oc-browser` | `@martinthommesen/oc-browser` | Not yet   |

Each plugin lives in `packages/<plugin name>`.

## Releasing

release-please runs in manifest mode (`release-please-config.json`,
`.release-please-manifest.json`) and releases each plugin on its own, with
its own pull request and tagged `<plugin name>-v<version>`. While a plugin
is below 1.0, a breaking change bumps the minor version.

Publishing is not set up yet. npm trusted publishing from `release.yml`
needs no token but can only be configured once a package exists on npm, so
each plugin's first version, 0.1.0, is published once by hand and tagged
`<plugin name>-v0.1.0`. Then add the trusted publisher on npmjs.com (user
`martinthommesen`, repository `oc-plugins`, workflow `release.yml`) and set
the plugin's repository variable, such as `OC_AUTH_NPM_PUBLISH`, to `true`;
until then its publish step is skipped. A new trusted publisher expires
unless a publish uses it within 48 hours, so add it shortly before a
release.
