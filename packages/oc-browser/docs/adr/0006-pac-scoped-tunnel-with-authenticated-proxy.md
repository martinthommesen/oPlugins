# A PAC-scoped tunnel through an authenticated proxy in the native host

With a remote server, pages in agent tabs reach that server's localhost and LAN
through a tunnel. Chrome can only send traffic through a running proxy, and
`chrome.proxy` applies to the whole profile rather than to single tabs. So the
native host runs an HTTP proxy on a random `127.0.0.1` port while a remote
attachment is active, and a PAC script routes only localhost, `127.0.0.0/8`, and
private ranges through it.

## Considered options

- **An unauthenticated proxy on a random port.** Rejected: any local process
  could use it, the flaw researchers found in Claude in Chrome's native host
  socket. The proxy instead demands credentials generated when it starts, which
  the extension supplies through `webRequest.onAuthRequired`.
- **Proxy all traffic.** Rejected: all of the user's personal browsing would go
  through the remote server.
- **No tunnel.** Rejected: remote setups couldn't reach the dev servers they
  run.

## Consequences

- While the tunnel is active, the user's own localhost tabs reach the remote
  machine too.
- This is the native host's only listening socket, and it exists only while a
  remote attachment is active.
