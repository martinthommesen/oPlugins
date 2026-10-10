# oBrowse

An OpenCode V2 server plugin (`src/index.ts`, Effect API), TUI plugin
(`src/tui.ts`), and Chrome extension (`extension/`) that let OpenCode drive
the user's browser.

The repository root `AGENTS.md` and `LINTING.md` hold the checks, lint
policy, and module shape this package follows.

# Design

`docs/design.md` is the agreed v1 design, and `docs/adr/` records why its
hard-to-reverse parts are as they are. Read both before changing the
architecture, the transport, the safety model, or packaging; a change that
contradicts an ADR needs a new ADR. `GLOSSARY.md` holds the project's terms:
use them in code, docs, and messages.

# Platform

`src/node-platform.ts` provides the Node implementations of the Effect
platform services; add a service's Node layer there when the plugin first
needs it. Environment variables and process facts come from the
`Environment` service (`src/environment.ts`).

Long-lived state (connections, pending requests, the active tab) lives in
`Ref`s owned by a service's layer.

# Extension

The extension runs in Chrome as a Manifest V3 extension, not in Node.
esbuild bundles `extension/service-worker.ts` with everything it imports
into `dist/extension/`, and the build writes `extension/manifest.json`
beside it with `package.json`'s version stamped in; load that folder
unpacked in `chrome://extensions`.

- `extension/tsconfig.json` types it with Chrome's APIs instead of Node's,
  and the root `.oxlintrc.json` override for `packages/obrowse/extension/**`
  swaps Node's globals for the browser's. `pnpm run typecheck` and
  `pnpm run lint:effect` check the plugin project, then the extension
  project. Never import a `node:` module or a `src/` module that needs
  Node.
- Code shared with the plugin, such as the message schemas, lives in
  `src/`, is imported as `#src/<file>.ts`, and depends on nothing but
  `effect`.
- Wrap `chrome.*` APIs in Effect services, so tests replace them through
  layers.
- Ask for each manifest permission when a feature first needs it, and say
  why in the change that adds it.

# Tests

Fake layers stand in for the host and for Chrome's APIs.

`pnpm run test:host` packs the plugin, installs it with the targeted
OpenCode CLI into a temporary sandbox, and checks that the host starts it.
