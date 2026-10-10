# anti-slop provenance

- Source: https://github.com/dmmulroy/anti-slop
- Commit: `c44ef22ca116d0ba62a3ff663a0bd13a3f3fa40b` (installed 2026-10-10)
- Copied from: `install-anti-slop` skill bundle (`skills/install-anti-slop/assets/anti-slop`, skill folder tree `89044d21c75a367eac1ddbaf208e650b1a7d5820`). Verified identical to upstream `src/` at that commit, excluding `*.test.ts` files, which the bundle omits.
- Installed path: `tools/oxlint/anti-slop/`
- Registered entry points: `./tools/oxlint/anti-slop/index.ts` (`anti-slop`). The Effect entry point (`effect/index.ts`) is copied but not registered because this repository does not depend on `effect`.

## Deviations

- No source modifications.
- Upstream develops against `oxlint`/`@oxlint/plugins` 1.78.0; this repository pins both at 1.56.0. All upstream RuleTester suites pass at 1.56.0. Strict `tsc` on the vendored source reports two type-only errors against the 1.56.0 plugin typings (`rules/no-widen-then-assert.ts`, `shared/function-parameters.ts`); the repository's `typecheck` covers only `src/`, so they do not affect checks.
