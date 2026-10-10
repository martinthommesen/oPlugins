# oPlugins

OpenCode v2 plugins, one package each.

## Development

Requires Node 22.18 or newer and pnpm 11.

```sh
pnpm install
pnpm run check
```

`check` runs lint, format check, typecheck, Effect diagnostics, and tests
for every package. See `AGENTS.md` for the policy behind them.

## Packages

| Package                | npm name               | Published |
| ---------------------- | ---------------------- | --------- |
| `packages/claude-auth` | `oclaude`              | Planned   |
| `packages/auto-review` | `opencode-auto-review` | Private   |
| `packages/advisor`     | `opencode-advisor`     | Private   |
| `packages/obrowse`     | `obrowse`              | Planned   |

## Releasing

release-please runs in manifest mode (`release-please-config.json`,
`.release-please-manifest.json`) and releases `oclaude` and `obrowse`, each
with its own pull request and tagged `<package>-v<version>`.

- `oclaude`: tags from before the move are named
  `opencode-claude-auth-v<version>`. The config pins the first release to
  `3.0.0` with `release-as`; remove that line once 3.0.0 is out.
- `obrowse`: never released. Its next version follows from `0.1.0` and the
  commits since; pin one with `release-as` if it should start elsewhere.

Publishing is not set up yet for either package. The plan is npm trusted
publishing from `release.yml`, which needs no token but can only be
configured once a package exists on npm, so each package's first version is
published once by hand. Then add the trusted publisher on npmjs.com (user
`martinthommesen`, repository `oPlugins`, workflow `release.yml`) and set
the package's repository variable, `OCLAUDE_NPM_PUBLISH` or
`OBROWSE_NPM_PUBLISH`, to `true`; until then that package's publish step is
skipped. A new trusted publisher expires unless a publish uses it within 48
hours, so add it shortly before a release.
