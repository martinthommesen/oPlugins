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
`3.0.0` with `release-as`; remove that line once 3.0.0 is out. Publishing
needs an `NPM_TOKEN` secret, and npm provenance requires the
`repository` field in `packages/claude-auth/package.json` to name this
repository.
