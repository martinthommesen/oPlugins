# A package in the oc-plugins monorepo

oc-browser lives in oc-plugins, the pnpm monorepo of the maintainer's OpenCode
plugins, as `packages/oc-browser`, rather than in a repository of its own.
oc-browser was scaffolded with oc-auth's lint, compiler, and test setup, and
oc-plugins now enforces that setup, plus the Effect language service
diagnostics, for every package from one root configuration. oc-plugins
already runs release-please in manifest mode, which
[ADR 0005](0005-bun-compiled-host-in-platform-packages.md) calls for.

## Considered options

- **Its own repository: a pnpm workspace with the plugin at its root**, as
  the design first planned. Rejected: it would keep its own copy of the lint
  policy and the vendored lint rules, which would drift from the other
  plugins' copies whenever the policy changes.

## Consequences

- The lint policy, compiler options, and Effect diagnostics come from the
  oc-plugins root. The extension's lint override is scoped to
  `packages/oc-browser/extension/**` in the root `.oxlintrc.json`.
- The plugin package keeps `src/` and `extension/` and will keep `host/`
  inside `packages/oc-browser`. The `@martinthommesen/oc-browser-host-<platform>` packages join
  the oc-plugins workspace.
- The oc-browser packages still version together, as one release-please group
  of their own; the other oc-plugins packages keep their own versions.
- Each oc-browser package names `martinthommesen/oc-plugins` as its
  `repository`, which npm provenance and trusted publishing check.
