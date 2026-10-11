# oc-auth

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

Every user setting is a plugin option, decoded from the host's plugin
context by the `PluginOptions` service (`src/plugin-options.ts`) with the
`@oc-lib/plugin-options` library; an invalid option fails plugin start with
a `PluginOptionsError`. Environment variables are only test overrides and
variables other programs own.

The plugin logs only through Effect's logger, which the host writes to its
own log, using the helpers in `src/plugin-log.ts`. Each record's message is
its event's stable snake_case name. Warnings carry metadata only; content
such as error messages and paths goes in debug records, which pass through
the `@oc-lib/log-redaction` library. No record carries credentials,
prompts, file contents, bodies, or model output.

Long-lived state (backoff, in-flight refreshes, the active credential) lives
in `Ref`s owned by a service's layer.

# Tests

Fake `ChildProcessSpawner` layers stand in for the macOS `security` tool.
`CapturedLogs`, from the dev-only `@oc-lib/captured-logs` library, is the
test logger: a test that pins a warning reads the records it kept.

Tests get their services from `@effect/vitest` layer blocks, never from
`Effect.provide`: `it` is imported as `test`, and each test runs in a
`test.layer(layer)((it: Tests) => { ... })` block of its own, so no fake's
state leaks between tests. `Tests` is a local interface naming the block's
services (`readonly effect: Vitest.Test<... | Scope.Scope>`), because the
block's own `it` type is not deeply readonly. A test-support helper that
builds a fresh component per call uses `Layer.build` in its own scope.

`pnpm run test:host` builds the plugin and loads it into a headless OpenCode
host (`scripts/test-host.ts`, on the shared `@oc-lib/host-test`).
