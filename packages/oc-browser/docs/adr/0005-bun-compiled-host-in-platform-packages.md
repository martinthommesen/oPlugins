# A Bun-compiled host in per-platform packages

The native host is compiled into one executable per platform with Bun
`--compile` and published as `@martinthommesen/oc-browser-host-<platform>` optional packages,
the way esbuild ships its binaries. OpenCode installs as a compiled binary,
so a user's machine may have no JavaScript runtime, and Chrome starts hosts
with a minimal `PATH`. Bun cross-compiles every target from one CI runner;
Node's single-executable apps need a build per OS and architecture.

## Consequences

- The repository becomes a pnpm workspace that publishes several packages,
  versioned together with release-please in manifest mode.
- Bun is a build-time tool in an otherwise Node repository. The host's
  Effect code runs on Bun's Node compatibility layer and must be tested
  there.
