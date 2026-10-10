# A PAC-scoped tunnel through an authenticated host proxy

With a remote OpenCode server, agent pages reach that server's localhost
and LAN through a tunnel. Chrome can only send traffic to a proxy that is
actually running, and `chrome.proxy` applies to the whole profile rather
than to single tabs. So the host runs an HTTP proxy on a random
`127.0.0.1` port while a remote attachment is active, and a PAC script
routes only localhost, `127.0.0.0/8`, and private ranges through it.

## Considered options

- **An unauthenticated proxy on a random port.** Rejected: any local
  process could use it, the flaw researchers found in Claude in Chrome's
  host socket. The proxy instead demands credentials generated for that
  run, supplied by the extension through `webRequest.onAuthRequired`.
- **Proxy all traffic.** Rejected: all of the user's personal browsing
  would go through the remote server.
- **No tunnel.** Rejected: remote setups could not reach the dev servers
  they run.

## Consequences

- While the tunnel is active, the user's own localhost tabs reach the
  remote machine too.
- This is the host's only listening socket, and it exists only while a
  remote attachment is active.
