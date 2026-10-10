# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (installed 2026-10-10)
- Copied from: `install-anti-slop` skill bundle (`skills/install-anti-slop/assets/anti-slop`, skill folder tree `89044d21c75a367eac1ddbaf208e650b1a7d5820`, per `~/.agents/.skill-lock.json`). The commit is taken from `opencode-claude-auth`'s installation of the same skill folder tree, which recorded it after verifying the bundle against upstream `src/` (bundle omits `*.test.ts`). This copy is byte-identical to that installation.
- Installed path: `tools/oxlint/anti-slop/`
- Registered entry points: `./tools/oxlint/anti-slop/index.ts` (`anti-slop`) and `./tools/oxlint/anti-slop/effect/index.ts` (`anti-slop-effect`; this repository depends on `effect` directly).

## Deviations

- No source modifications.
- Upstream develops against `oxlint`/`@oxlint/plugins` 1.78.0; this repository pins both at 1.87.0.
