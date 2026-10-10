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

## Releasing

release-please runs in manifest mode (`release-please-config.json`,
`.release-please-manifest.json`) and releases only `oclaude`, tagged
`oclaude-v<version>`. Tags from before the move are named
`opencode-claude-auth-v<version>`. The config pins the first release to
`3.0.0` with `release-as`; remove that line once 3.0.0 is out.

Publishing is not set up yet. The plan is npm trusted publishing from
`release.yml`, which needs no token but can only be configured once the
package exists on npm, so the first version is published once by hand.
Then add the trusted publisher on npmjs.com (user `martinthommesen`,
repository `oPlugins`, workflow `release.yml`) and set the repository
variable `OCLAUDE_NPM_PUBLISH` to `true`; until then the workflow's publish
step is skipped. A new trusted publisher expires unless a publish uses it
within 48 hours, so add it shortly before a release.
