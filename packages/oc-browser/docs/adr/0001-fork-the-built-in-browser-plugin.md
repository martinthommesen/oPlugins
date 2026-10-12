# Fork OpenCode's built-in browser plugin

OpenCode 2.0.26 ships `opencode.browser`, a plugin whose tools, code-mode shape,
and server RPC protocol drive the desktop app's embedded browser. oc-browser
forks its server code (MIT) into its own `oc-browser` namespace and adapts it to
Chrome, rather than writing the tool layer from scratch or making the extension
a client of the built-in's own protocol.

## Considered options

- **Speak the built-in's protocol from the extension.** No server plugin, and
  every tool comes with it. Rejected: the contract is internal and versioned
  (`version: 4`), so any OpenCode release can break it. Its permission model
  attaches one session at a time and enforces no per-site checks, so
  oc-browser's site grants would have to live in the extension.
- **Own plugin and protocol, written fresh.** Full control, but it means
  rewriting more than forty tools the built-in already has.

## Consequences

- oc-browser owns a diverging fork. `UPSTREAM.md` records the fork point, and
  each update of the targeted OpenCode version includes reading the upstream
  diff.
- The built-in stays installed and enabled. It's hidden unless the desktop app's
  browser pane attaches, and its `browser` namespace never collides with
  `oc-browser`.
