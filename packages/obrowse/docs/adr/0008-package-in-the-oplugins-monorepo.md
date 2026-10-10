# A package in the oPlugins monorepo

oBrowse lives in oPlugins, the pnpm monorepo of the maintainer's OpenCode
plugins, as `packages/obrowse`, rather than in a repository of its own.
oBrowse was scaffolded with oClaude's lint, compiler, and test setup, and
oPlugins now enforces that setup, plus the Effect language service
diagnostics, for every package from one root configuration. oPlugins
already runs release-please in manifest mode, which
[ADR 0005](0005-bun-compiled-host-in-platform-packages.md) calls for.

## Considered options

- **Its own repository: a pnpm workspace with the plugin at its root**, as
  the design first planned. Rejected: it would keep its own copy of the lint
  policy and the vendored lint rules, which would drift from the other
  plugins' copies whenever the policy changes.

## Consequences

- The lint policy, compiler options, and Effect diagnostics come from the
  oPlugins root. The extension's lint override is scoped to
  `packages/obrowse/extension/**` in the root `.oxlintrc.json`.
- The plugin package keeps `src/` and `extension/` and will keep `host/`
  inside `packages/obrowse`. The `@obrowse/host-<platform>` packages join
  the oPlugins workspace.
- The oBrowse packages still version together, as one release-please group
  of their own; the other oPlugins packages keep their own versions.
- Each oBrowse package names `martinthommesen/oPlugins` as its
  `repository`, which npm provenance and trusted publishing check.
