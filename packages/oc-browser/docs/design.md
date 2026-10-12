# oc-browser design

Status: accepted target design for v1, 2026-10-10. None of it is built yet:
package names, commands, and file paths below are planned, not existing.
[`GLOSSARY.md`](../GLOSSARY.md) defines the terms it uses, and each decision
that is hard to reverse has an ADR in [`adr/`](adr/). Feasibility isn't proven
everywhere: see [Risks](#risks-to-settle-before-building) and
[Open questions](#open-questions).

oc-browser lets an OpenCode agent work in the user's own Chrome, with the user's
sign-ins, the way Claude in Chrome serves Claude Code and Codex's Chrome
extension serves Codex. It has three parts: an OpenCode server plugin, a native
host on the browsing machine, and a Chrome extension.

## Goals

- **Signed-in sites first.** The agent reads and acts on sites the user is
  already signed into, such as GitHub, Jira, ServiceNow, and SSO dashboards.
  Driving a localhost app under development comes second. A separate automation
  browser is out of scope, because it would need no extension.
- **Public from v1.** The plugin and the native host ship on npm, and the
  extension on the Chrome Web Store. Every choice below has to pass store review
  and install cleanly for any user.
- **Platforms.** macOS and Linux. Windows comes later. It registers native hosts
  in the registry rather than in a file.
- **Browsers.** Google Chrome is the only browser v1 supports and tests. Nothing
  hard-codes it. The install paths for each browser stay a list, so Edge, Brave,
  and Arc can follow.

## Architecture

```text
OpenCode server (local or remote)
  oc-browser server plugin: one instance per location
    tools · site grants · protocol · Lighthouse
        ▲  plugin RPC + event stream (HTTP, server credentials)
        │
Browsing machine
  native host: compiled binary that Chrome starts
        ▲  native messaging (stdio)
        │
  Chrome extension: service worker, DevTools protocol via chrome.debugger
```

The OpenCode server is the broker. The native host accepts no connections except
through the tunnel's proxy (see
[Remote servers and the tunnel](#remote-servers-and-the-tunnel)), so other local
processes have no socket to reach apart from that authenticated proxy.

### Server plugin

The server plugin is a fork of OpenCode's built-in `opencode.browser` plugin
(MIT), which drives the OpenCode desktop app's embedded browser
([ADR 0001](adr/0001-fork-the-built-in-browser-plugin.md)).

- **Namespace.** Tools live in the `oc-browser` namespace, with the `oc-browser`
  permission action. They never collide with the built-in's `browser` namespace,
  which oc-browser leaves alone. The built-in stays hidden unless the desktop
  app's browser pane attaches, and the README explains how to turn it off
  (`"-opencode.browser"`).
- **Tools.** The server plugin has every tool group the built-in has: tabs,
  navigation, observation (snapshot, find, evaluate, wait, screenshot), input,
  diagnostics (console, network), files, performance (trace, CPU), memory
  (heap), Lighthouse, and the tunnel.
- **Code mode.** The tools stay separate and keep OpenCode's default code mode,
  so the model composes them in JavaScript (`tools["oc-browser"].click(...)`),
  as in Codex. OpenCode still applies its permission rules to each call, and
  shows and logs each one.
- **Element targeting.** A page snapshot is an accessibility tree of one tab,
  with `[ref_N]` identifiers that go stale when that tab navigates. Input tools
  take a ref, or viewport coordinates read off a screenshot.
- **Lighthouse.** The server plugin runs Lighthouse, which drives the page
  through the relay: raw DevTools access to an agent tab, carried through the
  native host and the extension.
- **Fork upkeep.** `UPSTREAM.md` records the OpenCode tag and the
  `packages/plugin-browser` commit the fork came from. Each update of the
  targeted OpenCode version includes reading the upstream diff and porting the
  fixes that apply, safety and protocol fixes first.

### Native host

- **Packaging.** The native host is an Effect program in TypeScript, compiled
  with Bun `--compile` into one executable per platform (darwin-arm64,
  darwin-x64, linux-x64, linux-arm64) and published as optional packages named
  `@martinthommesen/oc-browser-host-<platform>`
  ([ADR 0005](adr/0005-bun-compiled-host-in-platform-packages.md)). The browsing
  machine needs no JavaScript runtime.
- **Installation.** When the server plugin starts on the browsing machine, it
  copies the native host into OpenCode's data directory and rewrites Chrome's
  native messaging manifest, so each plugin update also updates the native host.
  With a remote server, the user runs
  `npx @martinthommesen/oc-browser install-host` on the browsing machine.
- **Allowed caller.** The native messaging manifest's `allowed_origins` holds
  exactly one extension ID. The extension manifest's `key` is the Web Store
  item's public key, so unpacked development builds share the store ID.
- **Credentials.** With a local server, the native host reads the URL and
  password of OpenCode's background service from
  `$XDG_STATE_HOME/opencode/service.json`, so there is no pairing. With a remote
  server, it uses a paired token (see
  [Remote servers](#remote-servers-and-the-tunnel)).

### Extension

- **Control.** The extension does everything through `chrome.debugger`, the
  DevTools protocol: input as trusted events, screenshots of background tabs,
  snapshots from `Accessibility.getFullAXTree` and `DOM`, console, network, and
  JavaScript that ignores the page's CSP. It has no content scripts, and browser
  control needs no host permissions
  ([ADR 0003](adr/0003-devtools-protocol-only.md)). The tunnel's proxy
  authentication may still need some (risk 2).
- **Debugger.** The extension attaches the debugger to a tab the first time a
  session uses the tab, and keeps it attached while the tab is in an agent tab
  group, so console and network history is complete. Chrome shows its
  "oc-browser started debugging this browser" bar for that whole time.
- **Manifest.** Planned permissions: `debugger`, `tabs`, `tabGroups`,
  `nativeMessaging`, `notifications`, `proxy`, `webRequest`,
  `webRequestAuthProvider`, `storage`, plus any host permissions risk 2 turns
  up. `incognito` is `spanning`.
- **Options page.** It lists the site grants the connected server holds, each
  with a revoke button.

## Connection lifecycle

The service worker can't hold the connection to the OpenCode server. OpenCode
offers plugin RPC and events only over HTTP and SSE. Chrome stops a worker whose
`fetch()` response takes more than 30 seconds, and the protocol holds an attach
request open for as long as the attachment lasts. An open native messaging port
keeps both the worker and the native host alive without artificial keepalives,
so the native host holds the server connection
([ADR 0002](adr/0002-native-messaging-host-with-server-broker.md)).

- **Attachment.** The native host subscribes to the server's event stream. When
  a tool call finds no attachment for its location, that location's server
  plugin emits a "wanted" event, and the native host attaches to that location.
  When OpenCode evicts a location for inactivity, its attachment ends.
- **One browser per server.** The last browser to connect wins. The browser it
  replaces is told so, and doesn't reconnect by itself.
- **Browser not connected.** With a local server, the server plugin launches
  Chrome (`open -a "Google Chrome"` on macOS, `google-chrome` on Linux) and
  waits up to 30 seconds. With a remote server, the call fails at once and tells
  the user to open Chrome with oc-browser on the browsing machine.
- **Versions.** The Chrome Web Store updates the extension on its own schedule,
  and the user updates the plugin through npm on theirs, so attaching negotiates
  a protocol version. Each side speaks the current and the previous version. A
  wider gap fails with a message that names the side to update.
- **No replay.** As in the built-in, a lost response doesn't prove that an
  action didn't happen, so oc-browser never repeats a call by itself.

## Sessions and tabs

- **Sessions.** Every session has the browser tools, and a session's first call
  creates its agent tab group.
- **One group per root session.** Sessions run in parallel and can't touch each
  other's tabs. A subagent session uses the group and the site grants of its
  root session.
- **Scope.** The agent uses only the tabs in its own group, including tabs the
  user drags into it. Tab listings show no other tab, so ungranted or personal
  tabs never reach the model.
- **Visibility.** The labeled, colored tab group shows the user which tabs the
  agent works in. Closing the group stops that session's browser work, and
  pending calls fail as stopped by the user.
- **After a session.** When a session ends or is deleted, its group stays as it
  is, and a resumed session uses it again.
- **Incognito.** The agent opens incognito tabs only when a call asks for them
  and the user has allowed oc-browser in incognito
  ([ADR 0007](adr/0007-incognito-in-spanning-mode.md)).

## Safety

Page content in a signed-in browser is untrusted input, and it can steer an
agent. The safeguards below assume a page will try. They reduce what a hostile
page can achieve, but none guarantees it achieves nothing. None protects against
other code running as the user either, which can read OpenCode's credentials and
storage as easily as Chrome's.

### Site grants

- **Every operation needs one.** Navigating to, opening, reading,
  screenshotting, and acting on a site all need a site grant, so a page can't
  send the agent to `attacker.example/?leak=...`. JavaScript on a granted site
  can still reach other sites (`fetch`, `location.href`), so outside trusted
  mode the user confirms each JavaScript run.
- **Scope.** A grant covers a registrable domain, found with the Public Suffix
  List: `github.com` covers `gist.github.com`, while `alice.github.io` and
  `bob.github.io` stay separate.
- **Answers.** _Once_ lasts until the session ends, _always_ persists, and
  _deny_ refuses. The user can deny sites in advance, so oc-browser never asks
  about them.
- **Storage and enforcement.** The server plugin keeps grants in its storage,
  which every location shares, and checks them before it forwards any command.
  Grants are then enforced in one place that neither pages nor the extension can
  override
  ([ADR 0004](adr/0004-server-enforced-site-grants-prompted-in-browser.md)). The
  server plugin keeps incognito grants apart, in memory only.
- **Relay.** Accepted requirement: the relay works only on tabs whose site is
  granted, and relayed navigation, new targets, and frame loads to an ungranted
  site raise the normal site prompt. Enforcing this is unsolved: relayed
  `Runtime.evaluate` can navigate, send requests, and touch sensitive fields
  without any navigation command, and redirects and frames add more paths. This
  is a blocking security investigation (risk 6).

### Prompts

OpenCode doesn't let server plugins open its own permission prompt, so prompts
appear in Chrome: a system notification plus a small extension window that names
the session, the site, and the action.

- **Kinds.** The site prompt (once, always, deny), the JavaScript confirmation
  (shows the code and the site), and the handoff (asks the user to complete a
  step in the tab).
- **Timeout.** A prompt nobody answers fails as not answered after 2 minutes.
  The forked server plugin gives each browser command 60 seconds, so the design
  proposes, without deciding yet, that this timeout pause while the command's
  prompt is pending. Cancellation and the 2-minute deadline still apply.
- **Handoff.** The agent resumes when the user clicks Done, or when the user
  fills and submits the field.

### Safe defaults and trusted mode

By default, oc-browser hands every sensitive field to the user and asks the user
to confirm every JavaScript run. Trusted mode, one global plugin option, lets a
site grant cover both. It's a plugin option rather than a prompt answer, so no
page can obtain it through a prompt.

### Prompt injection

Every tool result wraps text from the page in a delimited "untrusted web
content" envelope, and the tool descriptions tell the model never to follow
instructions inside one. There is no classifier model in v1.

## Remote servers and the tunnel

The browser can serve a remote server, such as OpenCode on an SSH box, a
development VM, or a cloud development environment, as well as OpenCode's local
background service.

- **Pairing.** On the remote server's machine, `opencode pair` prints a one-time
  link. On the browsing machine,
  `npx @martinthommesen/oc-browser connect <link>` redeems it and stores the
  server's URL and token in a file only the user can read. Tokens last 30 days.
  An expired token makes tool calls fail with a message that asks the user to
  pair oc-browser again, and raises a toast in OpenCode's terminal interface.
- **Tunnel.** Pages in agent tabs reach the remote server's localhost and LAN
  through the tunnel. `chrome.proxy` applies to the whole profile and can't pick
  tabs. So while a remote attachment is active, a PAC script sends only
  localhost, `127.0.0.0/8`, and private ranges through the tunnel, and public
  sites go direct. For that time, the user's own localhost tabs reach the remote
  machine too.
- **Proxy listener.** The PAC script points to an HTTP proxy that the native
  host runs on a random `127.0.0.1` port, only while the tunnel is active. The
  proxy demands credentials generated when it starts, which the extension
  supplies through `webRequest.onAuthRequired`. Any other process gets `407`
  ([ADR 0006](adr/0006-pac-scoped-tunnel-with-authenticated-proxy.md)).

## Packaging and release

- **Repository.** oc-browser lives in `packages/oc-browser` in the oc-plugins
  pnpm monorepo
  ([the repository's ADR 0001](../../../docs/adr/0001-every-plugin-lives-in-oc-plugins.md)).
  The source of the `@martinthommesen/oc-browser` plugin package is in `src/`,
  the native host's in `host/`, and the extension's in `extension/`, each folder
  flat.
- **Release.** release-please in manifest mode versions the oc-browser packages
  together. From the same release, CI builds the native host binaries, publishes
  `@martinthommesen/oc-browser` and the
  `@martinthommesen/oc-browser-host-<platform>` packages, and submits the
  extension to the Chrome Web Store.

## Testing

- **Unit.** Vitest, with fake layers in place of Chrome's APIs and the native
  host.
- **End to end.** A CI job runs Chrome for Testing, which still accepts
  `--load-extension`, with the built extension and native host against the real
  OpenCode CLI, and drives a local fixture site through the tools.

## Privacy

oc-browser runs no service and collects nothing. Page content travels from
Chrome through the native host to the OpenCode server the user connected, and
from there to the user's model provider. The Web Store privacy policy says the
same.

## Risks to settle before building

Each of these could change a decision above, so test each with a spike first.

1. **Store review.** Whether the Chrome Web Store accepts `debugger`,
   `nativeMessaging`, `proxy`, `webRequestAuthProvider`, `tabGroups`, and
   `notifications` together in one public extension.
2. **Proxy authentication without host permissions.** Whether
   `webRequest.onAuthRequired` fires for proxy challenges when the extension
   holds no host permissions. If not, the manifest needs host permissions after
   all.
3. **Effect on Bun.** Whether the native host's Effect platform code runs in a
   Bun-compiled binary on all four targets.
4. **Lighthouse over the relay.** Whether Lighthouse runs against a relayed
   DevTools connection, and what its install size does to the plugin package.
5. **The fork's base.** How much the built-in's internal contract (attach
   version 4) changes between OpenCode releases.
6. **Enforcing grants under arbitrary JavaScript (blocking).** How the relay,
   and JavaScript runs in trusted mode, can be held to site grants and the
   sensitive-field rules when script can navigate, send requests, follow
   redirects, and load frames without an explicit command.

## Open questions

These follow from decisions already made and need answers before the parts they
touch are built.

- **When a session ends.** A once grant lasts until the session ends, but agent
  tab groups persist and sessions resume. Which event ends a session for this
  purpose: deletion, interruption, idling?
- **Local or remote.** How the server plugin tells whether the browsing machine
  is the server's own machine. The answer decides between launching Chrome and
  failing fast, and whether the server plugin installs the native host.
- **Standalone servers.** Whether and how the native host finds a `--standalone`
  OpenCode server, which runs on a random port with a random password.
- **Proxy cleanup.** How the profile's proxy settings are restored when the
  native host crashes, is replaced, or loses its attachment, so the user's own
  localhost browsing never hangs on a dead proxy.
- **Sites without a registrable domain.** What a site is for `localhost`, IP
  addresses, and other hostnames with no registrable domain.
- **Frames from other sites.** Whether reading or acting on a granted page also
  needs grants for the sites of the frames embedded in it.

## Sources

- Chrome extension service worker lifetime:
  <https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle>
- Native messaging:
  <https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging>
- Offscreen documents:
  <https://developer.chrome.com/docs/extensions/reference/api/offscreen>
- Extension network requests and CORS:
  <https://developer.chrome.com/docs/extensions/develop/concepts/network-requests>
- MV3 remote code policy and its Debugger API exemption:
  <https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements>
- Claude in Chrome with Claude Code: <https://code.claude.com/docs/en/chrome>
- Claude in Chrome permissions:
  <https://support.claude.com/en/articles/12902446-claude-in-chrome-permissions-guide>
- Claude in Chrome's unauthenticated native host socket and unsigned grants:
  <https://www.originhq.com/research/claude-for-chrome-takeover>
- Codex Chrome extension:
  <https://developers.openai.com/codex/app/chrome-extension>
- OpenCode v2.0.26 source: `packages/plugin-browser` (the forked plugin and its
  README), `packages/server/src/middleware/authorization.ts` and `pairing.ts`
  (credentials and pairing), `packages/core/src/plugin.ts` (plugin instances per
  location).
