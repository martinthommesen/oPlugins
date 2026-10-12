# A Bun-compiled native host in per-platform packages

The native host is compiled into one executable per platform with Bun
`--compile` and published as optional packages named
`@martinthommesen/oc-browser-host-<platform>`, the way esbuild ships its
binaries. OpenCode installs as a compiled binary, so a user's machine may have
no JavaScript runtime, and Chrome starts native hosts with a minimal `PATH`. Bun
cross-compiles every target from one CI runner, while Node's single-executable
apps need a build per OS and architecture.

## Consequences

- oc-browser publishes several packages, the plugin and one native host package
  per platform, which release-please in manifest mode versions together.
- Bun is a build-time tool in an otherwise Node repository. The native host's
  Effect code runs on Bun's Node compatibility layer and must be tested there.
