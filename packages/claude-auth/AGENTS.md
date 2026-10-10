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
`pnpm run test:host` builds the plugin and loads it into a headless OpenCode
host (`scripts/test-headless.ts`).
