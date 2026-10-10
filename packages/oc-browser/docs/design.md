# oc-browser design

Status: accepted target design for v1, 2026-10-10. None of it is built
yet: package names, commands, and file paths below are planned, not
existing. Terms in **bold** at first use are defined in
[`GLOSSARY.md`](../GLOSSARY.md); decisions that are hard to reverse have an
ADR in [`adr/`](adr/). Feasibility is not proven everywhere: see
[Risks](#risks-to-settle-before-building) and
[Open questions](#open-questions).

oc-browser lets an OpenCode agent work in the user's own Chrome, with the
user's sign-ins, the way Claude in Chrome serves Claude Code and the Chrome
extension serves Codex. It has three parts: an OpenCode server plugin, a
**native host** on the machine Chrome runs on, and a Chrome extension.

## Goals

- **Signed-in sites first.** The agent reads and acts on sites the user is
  already signed into (GitHub, Jira, ServiceNow, SSO dashboards). Driving a
  localhost app under development comes second. A separate automation
  browser is out of scope: it would need no extension.
- **Public from v1.** The plugin and host ship on npm, the extension on the
  Chrome Web Store. Every choice below has to pass store review and install
  cleanly for strangers.
- **Platforms.** macOS and Linux. Windows comes later; its native-host
  registration lives in the registry rather than a file.
- **Browsers.** Google Chrome is the only browser v1 supports and tests.
  Nothing hard-codes it: per-browser install paths stay a list, so Edge,
  Brave, and Arc can follow.

## Architecture

```
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

The OpenCode server is the broker. The host never accepts connections,
except for the tunnel's proxy (see [Remote servers](#remote-servers-and-the-tunnel)),
so there is no local socket for other processes to reach.

### Server plugin

The plugin is a fork of OpenCode's built-in `opencode.browser` plugin
(MIT), which drives the OpenCode desktop app's embedded browser
([ADR 0001](adr/0001-fork-the-built-in-browser-plugin.md)).

- **Namespace.** Tools live in the `oc-browser` namespace with the `oc-browser`
  permission action. They never collide with the built-in's `browser`
  namespace, which oc-browser leaves alone: the built-in stays hidden unless
  the desktop app's browser pane attaches. The README explains how to turn
  it off (`"-opencode.browser"`).
- **Tools.** Every tool group the built-in has: tabs, navigation,
  observation (snapshot, find, evaluate, wait, screenshot), input,
  diagnostics (console, network), files, performance (trace, CPU), memory
  (heap), Lighthouse, and the tunnel.
- **Code mode.** Tools are discrete and keep OpenCode's default code mode,
  so the model composes them in JavaScript (`tools["oc-browser"].click(...)`),
  Codex-style, while each call is still gated, shown, and logged
  separately.
- **Element targeting.** A page snapshot is an accessibility tree with
  `[ref_N]` identifiers for one tab, stale after that tab navigates. Input
  tools take a ref, or viewport coordinates read off a screenshot.
- **Lighthouse** runs in the plugin. It drives the page through the
  **relay**: raw DevTools access to an agent tab, carried through the host
  and extension.
- **Fork upkeep.** `UPSTREAM.md` records the OpenCode tag and
  `packages/plugin-browser` commit the fork came from. Every `HOST_VERSION`
  bump includes reading the upstream diff and porting relevant fixes,
  safety and protocol fixes first.

### Native host

- **Packaging.** An Effect/TypeScript program compiled into one executable
  per platform with Bun `--compile` (darwin-arm64, darwin-x64, linux-x64,
  linux-arm64), published as `@martinthommesen/oc-browser-host-<platform>` optional packages
  ([ADR 0005](adr/0005-bun-compiled-host-in-platform-packages.md)). The
  browsing machine needs no JavaScript runtime.
- **Installation.** When the plugin starts on the machine Chrome runs on,
  it copies the host into OpenCode's data directory and rewrites Chrome's
  native messaging manifest, so plugin updates update the host. With a
  remote server, the user runs `npx @martinthommesen/oc-browser install-host` on the browsing
  machine.
- **Allowed caller.** The manifest's `allowed_origins` holds exactly one
  extension ID. The extension manifest's `key` is the Web Store item's
  public key, so unpacked development builds share the store ID.
- **Credentials.** Locally, the host reads the background service's URL
  and password from `$XDG_STATE_HOME/opencode/service.json`, so there is no
  **pairing**. For a remote server it uses a paired token (see
  [Remote servers](#remote-servers-and-the-tunnel)).

### Extension

- **Control.** Everything goes through `chrome.debugger` (the DevTools
  protocol): input as trusted events, screenshots of background tabs,
  snapshots from `Accessibility.getFullAXTree` and `DOM`, console, network,
  and JavaScript that ignores the page's CSP. There are no content scripts,
  and browser control needs no host permissions
  ([ADR 0003](adr/0003-devtools-protocol-only.md)). The tunnel's proxy
  authentication may still need some (risk 2).
- **Debugger attachment.** The extension attaches to a tab the first time
  a session uses it, and stays attached while the tab is in an agent tab
  group, so console and network history is complete. Chrome shows its
  "oc-browser started debugging this browser" bar for that whole time.
- **Manifest.** Planned permissions: `debugger`, `tabs`, `tabGroups`,
  `nativeMessaging`, `notifications`, `proxy`, `webRequest`,
  `webRequestAuthProvider`, `storage`, plus any host permissions risk 2
  turns up. `incognito` is `spanning`.
- **Options page.** Lists the site grants held by the connected server,
  with revoke buttons.

## Connection lifecycle

The service worker cannot hold the server connection itself. OpenCode
offers plugin RPC and events only over HTTP and SSE; Chrome stops a worker
whose `fetch()` response takes more than 30 seconds, and the protocol keeps
an attach request open for its whole life. An open native messaging port
keeps both the worker and the host alive without artificial keepalives, so
the host holds the server connection
([ADR 0002](adr/0002-native-messaging-host-with-server-broker.md)).

- **Attachment.** The host subscribes to the server's event stream. When a
  tool call finds no **attachment** for its **location**, that location's
  plugin emits a "wanted" event; the host attaches to that location. A
  location OpenCode evicts for inactivity detaches.
- **One browser per server.** The last browser to connect wins. The one it
  replaces is told so and does not reconnect by itself.
- **Browser not connected.** With a local server, the plugin launches
  Chrome (`open -a "Google Chrome"` on macOS, `google-chrome` on Linux) and
  waits up to 30 seconds. With a remote server, the call fails at once:
  "open Chrome with oc-browser on the machine you browse from".
- **Versions.** The Web Store updates the extension on its own schedule and
  npm updates the plugin on the user's, so attach negotiates a protocol
  version. Each side speaks the current and the previous version. A wider
  gap fails with which side to update.
- **No replay.** As in the built-in, a lost response does not prove an
  action did not happen; calls are never repeated automatically.

## Sessions and tabs

- **Every session** has the browser tools; a session's first call creates
  its **agent tab group**.
- **One group per root session.** Sessions run in parallel and cannot
  touch each other's tabs. Subagent sessions use their root session's
  group and grants.
- **Scope.** The agent uses only its own group's tabs, plus tabs the user
  drags into the group. Tab listings show nothing else, so ungranted or
  personal tabs never reach the model.
- **Visibility.** The labeled, colored tab group is the indicator. Closing
  it stops that session's browser work: pending calls fail as stopped by
  the user.
- **After a session.** When a session ends or is deleted, its group stays
  as it is, and a resumed session uses it again.
- **Incognito.** The agent opens incognito tabs only when a call asks for
  them and the user has allowed oc-browser in incognito
  ([ADR 0007](adr/0007-incognito-in-spanning-mode.md)).

## Safety

Page content in a signed-in browser is untrusted input, and an agent can be
steered by it. The layers below assume a page will try. They reduce what a
hostile page can achieve; none of them guarantees it achieves nothing, and
none protects against other code running as the user, which can read
OpenCode's credentials and storage as easily as Chrome's.

### Site grants

- **Everything needs one.** Navigating to, opening, reading, screenshotting,
  and acting on a **site** all need a **site grant**, so that a page cannot
  simply send the agent to `attacker.example/?leak=...`. JavaScript on a
  granted site can still reach other sites (`fetch`, `location.href`),
  which is why JavaScript is confirmed per run outside trusted mode.
- **Scope.** A grant covers a registrable domain, found with the Public
  Suffix List: `github.com` covers `gist.github.com`, while
  `alice.github.io` and `bob.github.io` stay separate.
- **Answers.** _Once_ lasts until the session ends, _always_ persists, and
  _deny_ refuses. The user can deny sites up front so they are never asked
  about.
- **Storage and enforcement.** Grants live in the server plugin's storage,
  shared across projects. The plugin checks them before it forwards any
  command, so enforcement sits in one place that neither pages nor the
  extension can override
  ([ADR 0004](adr/0004-server-enforced-site-grants-prompted-in-browser.md)).
  Incognito grants are kept apart, in memory only.
- **Relay.** Accepted requirement: the relay works only on tabs whose site
  is granted, and relayed navigation, new targets, and frame loads to an
  ungranted site raise the normal site prompt. Enforcing this is not
  solved: relayed `Runtime.evaluate` can navigate, send requests, and touch
  sensitive fields without any navigation command, and redirects and frames
  add more paths. This is a blocking security investigation (risk 6).

### Prompts

OpenCode does not let server plugins open its own permission prompt, so
**prompts** appear in Chrome: a system notification plus a small extension
window naming the session, the site, and the action.

- **Kinds.** The site prompt (once, always, deny), the JavaScript
  confirmation (shows the code and the site), and the **handoff** (asks the
  user to complete a step in the tab).
- **Timeout.** A prompt nobody answers fails after 2 minutes with "not
  answered". The forked server gives each browser command 60 seconds, so
  proposed (not yet decided): that timeout pauses while the command's
  prompt is pending. Cancellation and the 2-minute deadline still apply.
- **Handoff.** The agent resumes when the user clicks Done, or when the
  field is filled and submitted.

### Safe defaults and trusted mode

A fresh install hands password, one-time-code, and payment fields to the
user, and confirms every JavaScript run. **Trusted mode**, one global
plugin option, lets the site grant cover both. It is a plugin option rather
than a prompt answer, so no page can talk its way into it.

### Prompt injection

Every tool result wraps page-derived text in a delimited "untrusted web
content" envelope, and the tool descriptions tell the model never to follow
instructions found inside one. There is no classifier model in v1.

## Remote servers and the tunnel

The extension can serve an OpenCode server on another machine (an SSH box,
a dev VM, a cloud workspace) as well as the local background service.

- **Pairing.** On the remote, `opencode pair` prints a one-time link; on
  the browsing machine, `npx @martinthommesen/oc-browser connect <link>` redeems it and stores
  the URL and token in a file only the user can read. Tokens last 30 days.
  An expired token fails tool calls with "re-pair oc-browser" and raises a TUI
  toast.
- **Tunnel.** Agent pages reach the remote server's localhost and LAN
  through the tunnel. `chrome.proxy` applies to the whole profile and cannot
  pick tabs, so while a remote attachment is active a PAC script sends only
  localhost, `127.0.0.0/8`, and private ranges through it; public sites go
  direct. The user's own localhost tabs reach the remote machine for that
  time too.
- **Proxy listener.** The PAC script points to an HTTP proxy the host runs
  on a random `127.0.0.1` port, only while the tunnel is active. It demands
  credentials generated for that run, which the extension supplies through
  `webRequest.onAuthRequired`; any other process gets `407`
  ([ADR 0006](adr/0006-pac-scoped-tunnel-with-authenticated-proxy.md)).

## Packaging and release

- **Repository.** `packages/oc-browser` in the oc-plugins pnpm monorepo
  ([ADR 0001](../../../docs/adr/0001-every-plugin-lives-in-oc-plugins.md)). It holds the
  `@martinthommesen/oc-browser` plugin package (`src/`); the host source lives flat in `host/`,
  the extension flat in `extension/`.
- **Release.** release-please in manifest mode versions the oc-browser
  packages together. CI builds the host binaries, publishes `@martinthommesen/oc-browser` and the
  `@martinthommesen/oc-browser-host-<platform>` packages, and submits the extension to the Web
  Store from the same release.

## Testing

- **Unit.** Vitest with fake layers for Chrome's APIs and the host.
- **End to end.** A CI job runs Chrome for Testing (which still accepts
  `--load-extension`) with the built extension and host against the real
  OpenCode CLI, and drives a local fixture site through the tools.

## Privacy

oc-browser runs no service and collects nothing. Page content travels from
Chrome through the host to the OpenCode server the user connected, and from
there to the user's model provider. The Web Store privacy policy says
exactly that.

## Risks to settle before building

Each of these could change a decision above; spike it first.

1. **Store review.** Whether the Chrome Web Store accepts `debugger`,
   `nativeMessaging`, `proxy`, `webRequestAuthProvider`, `tabGroups`, and
   `notifications` together in one public extension.
2. **Proxy authentication without host permissions.** Whether
   `webRequest.onAuthRequired` fires for proxy challenges when the
   extension holds no host permissions. If not, the manifest needs host
   permissions after all.
3. **Effect on Bun.** Whether the host's Effect platform code runs in a
   Bun-compiled binary on all four targets.
4. **Lighthouse over the relay.** Whether Lighthouse runs against a
   relayed DevTools connection, and what its install size does to the
   plugin package.
5. **The fork's base.** How much the built-in's internal contract (attach
   version 4) changes between OpenCode releases.
6. **Enforcing grants under arbitrary JavaScript (blocking).** How the
   relay, and JavaScript runs in trusted mode, can be held to site grants
   and the sensitive-field rules when script can navigate, send requests,
   follow redirects, and load frames without an explicit command.

## Open questions

These follow from decisions already made and need answers before the
parts they touch are built.

- **When a session ends.** A once-grant lasts until the session ends, but
  agent tab groups persist and sessions resume. Which event ends a session
  for this purpose: deletion, interruption, idling?
- **Local or remote.** How the plugin tells whether the browsing machine is
  the server's own machine, which decides between launching Chrome and
  failing fast, and whether the plugin installs the host.
- **Standalone servers.** Whether and how the host finds a `--standalone`
  OpenCode server, which runs on a random port with a random password.
- **Proxy cleanup.** How the profile's proxy settings are restored when the
  host crashes, is replaced, or loses its attachment, so the user's own
  localhost browsing never hangs on a dead proxy.
- **Sites without a registrable domain.** What a site is for `localhost`,
  IP addresses, and other hosts with no registrable domain.
- **Frames from other sites.** Whether reading or acting on a granted page
  also needs grants for the sites of the frames embedded in it.

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
- Claude in Chrome's unauthenticated host socket and unsigned grants:
  <https://www.originhq.com/research/claude-for-chrome-takeover>
- Codex Chrome extension:
  <https://developers.openai.com/codex/app/chrome-extension>
- OpenCode v2.0.26 source: `packages/plugin-browser` (the forked plugin and
  its README), `packages/server/src/middleware/authorization.ts` and
  `pairing.ts` (credentials and pairing), `packages/core/src/plugin.ts`
  (plugin instances per location).
