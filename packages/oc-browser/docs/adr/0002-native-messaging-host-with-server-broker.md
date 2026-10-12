# A native host, with the OpenCode server as broker

The extension reaches OpenCode through a native host that Chrome starts. The
native host holds the OpenCode server's event stream and attach requests, on the
same plugin RPC route the built-in's desktop client uses. OpenCode offers that
route only over HTTP and SSE, which don't keep a Manifest V3 service worker
alive. An open `connectNative` port does keep both the worker and the native
host alive, without artificial keepalives. The server already brokers every
plugin instance, local or remote, so the native host needs no socket of its own.

## Considered options

- **Hold the connection in the service worker.** Chrome stops a worker whose
  `fetch()` response takes over 30 seconds, and a public extension may not keep
  a worker awake artificially. WebSocket traffic and debugger sessions extend a
  worker's life, but OpenCode has no WebSocket route for plugin RPC, and the
  debugger is attached only once the agent has used a tab.
- **Hold it in an offscreen document.** This works with no native install, but
  no offscreen reason fits "hold a connection", so a public listing risks
  rejection. The paired token would also expire every 30 days, with nothing on
  the machine able to renew it.
- **A WebSocket server in the server plugin**, as Browser MCP and Playwright's
  extension mode do. Rejected: plugins can't add routes to OpenCode's server, so
  the server plugin would open its own port. OpenCode runs one plugin instance
  per location, so the instances would need a broker of their own, and a remote
  server would have a second port to expose and secure.

## Consequences

- A remote setup needs `npx @martinthommesen/oc-browser install-host` on the
  browsing machine.
- With a local server, the native host reads the background service's own
  credentials, so there is no pairing step.
- Whether the native host can find a `--standalone` OpenCode server, which has a
  random port and password, is open (see the design's open questions).
