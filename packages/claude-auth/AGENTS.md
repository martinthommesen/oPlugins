# oClaude

An OpenCode V2 server plugin (`src/index.ts`, Effect API) and TUI plugin
(`src/tui.ts`) that let OpenCode use Claude Code subscription credentials.

The repository root `AGENTS.md` and `LINTING.md` hold the checks, lint
policy, and module shape this package follows.

# Platform

`src/node-platform.ts` provides the Node implementations of the Effect
platform services; the `security` tool is reached through
`ChildProcessSpawner`, and SHA-256 digests and UUIDs through `Crypto`.
Environment variables and process facts come from the `Environment` service
(`src/environment.ts`).

Long-lived state (backoff, in-flight refreshes, the active credential) lives
in `Ref`s owned by a service's layer.

# Tests

Fake `ChildProcessSpawner` layers stand in for the macOS `security` tool.

Tests get their services from `@effect/vitest` layer blocks, never from
`Effect.provide`: `it` is imported as `test`, and each test runs in a
`test.layer(layer)((it: Tests) => { ... })` block of its own, so no fake's
state leaks between tests. `Tests` is a local interface naming the block's
services (`readonly effect: Vitest.Test<... | Scope.Scope>`), because the
block's own `it` type is not deeply readonly. A test-support helper that
builds a fresh component per call uses `Layer.build` in its own scope.

`pnpm run test:host` builds the plugin and loads it into a headless OpenCode
host (`scripts/test-headless.ts`).
