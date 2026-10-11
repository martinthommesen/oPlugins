# oc-browser

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

The plugin uses no Effect platform service yet. When it first needs one,
add `src/node-platform.ts` with the service's Node layer, and build the
plugin's services into the plugin's scope in `src/index.ts` with
`Layer.build`, as oc-auth does: providing them would release them when
set-up returns.

Every user setting is a plugin option, decoded in
`src/oc-browser-plugin.ts`; an invalid or unknown option fails set-up.
Environment variables are only for test overrides.

Log with `Effect.logInfo` and its siblings: the message is a `snake_case`
event name and the details go in `Effect.annotateLogs`. The host writes the
records to its log. Records at info level and above carry metadata only;
debug records may carry content once the `@oc-lib/log-redaction` library
has redacted it; add the library as a devDependency when a record first
needs it.

Long-lived state (connections, pending requests, the active tab) lives in
`Ref`s owned by a service's layer.

# Extension

The extension runs in Chrome as a Manifest V3 extension, not in Node.
The second config in `tsdown.config.ts` bundles `extension/service-worker.ts`
with everything it imports into `dist/extension/`, and the build writes `extension/manifest.json`
beside it with `package.json`'s version stamped in; load that folder
unpacked in `chrome://extensions`.

- `extension/tsconfig.json` types it with Chrome's APIs instead of Node's,
  and the root `.oxlintrc.json` override for `packages/oc-browser/extension/**`
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
