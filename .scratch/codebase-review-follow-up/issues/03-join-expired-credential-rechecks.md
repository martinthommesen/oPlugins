# 03: Make expired requests join pending adoption

**What to build:** When the active credential has expired, every concurrent
request waits for its pending store recheck instead of receiving the expired
credential merely because the recheck cache window is still valid. Preserve the
fast path for credentials that remain valid. The review reproduced a second
request receiving an expired token while the first awaited adoption.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Concurrent requests with an expired active credential share the pending
      recheck and receive the adopted credential when it becomes available.
- [ ] A token expiring inside the cache window cannot bypass the expiry
      decision. Define the no-adoption outcome explicitly and preserve
      unauthorized recovery rather than promising that a failed store read
      yields new tokens.
- [ ] Requests with a still-valid token retain background rechecking and do not
      incur unnecessary store reads or block on a slow Keychain.
- [ ] Account switches and newer credential generations cannot be overwritten by
      a stale recheck. Cancelling one waiting request does not abandon work
      needed by other requests.
- [ ] Regression tests hold adoption at an explicit milestone, issue a second
      request, and verify neither completes early with the expired token. Cover
      expiry within the window, unchanged stores, and account switches.
- [ ] Match documentation to the resulting expiry behavior and run the
      repository checks.

## Coordination

Original codebase-review ticket 09 concerns following the host's selected
Anthropic connection. This follow-up concerns request-time expiry and pending
adoption, not a replacement for that ticket.
