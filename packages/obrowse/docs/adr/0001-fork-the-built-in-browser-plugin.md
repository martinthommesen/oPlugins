# Fork OpenCode's built-in browser plugin

OpenCode 2.0.26 ships `opencode.browser`, a plugin whose tools, code-mode
shape, and server-RPC protocol drive the desktop app's embedded browser.
oBrowse forks its server code (MIT) into its own `obrowse` namespace and
adapts it to Chrome, rather than writing the tool layer from scratch or
making the extension a client of the built-in's own protocol.

## Considered options

- **Speak the built-in's protocol from the extension.** No server plugin,
  and every tool for free. Rejected: the contract is internal and versioned
  (`version: 4`), so any OpenCode release can break it. Its permission
  model attaches one session at a time and enforces no per-site checks, so
  oBrowse's site grants would have to live in the extension.
- **Own plugin and protocol, written fresh.** Full control, but rewrites
  forty-odd tools the built-in already solves.

## Consequences

- oBrowse owns a diverging fork. `UPSTREAM.md` records the fork point, and
  every host bump includes reading the upstream diff.
- The built-in stays installed and enabled. It is hidden unless the desktop
  app's browser pane attaches, and its `browser` namespace never collides
  with `obrowse`.
