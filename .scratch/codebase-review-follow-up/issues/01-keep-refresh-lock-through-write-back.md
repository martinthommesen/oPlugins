# 01: Keep the refresh lock through write-back

**What to build:** A refresh keeps ownership of its credential store until the
token endpoint has answered and guarded write-back has finished. A slow Keychain
must not let another host process spend the same refresh token while the first
process is still saving its replacement. The review found that the lease covers
a 30-second exchange plus 15 seconds, while write-back can take longer.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Coordinated refreshes maintain a live lease through the token exchange,
      write-back preparation, guarded writes, verification, and permitted
      retries. Do not rely on a margin shorter than those operations can take.
- [ ] Losing ownership or failing to renew it before spending the refresh token
      prevents the exchange. A failure after tokens are issued follows an
      explicit recovery policy that prioritizes safe write-back and reports
      uncertain coordination without hiding it.
- [ ] A regression uses the real refresh lock with two independent refresh
      services sharing a temporary credential store. A near-deadline exchange
      and slow write-back do not let the second service start another exchange.
- [ ] Tests cover renewal failure, completion, and interruption without leaking
      renewal work or leaving ownership indefinitely live. Existing cooldown,
      degraded-lock, and guarded-write behavior remains covered.
- [ ] Use synthetic credentials and controlled time, not live accounts or the
      real token endpoint. Run the repository checks and update behavior docs.

## Coordination

Coordinate the lease lifecycle with follow-up ticket 02, which protects
write-back during shutdown. Neither ticket requires an implementation API from
the other; a shared file alone is not a blocker. Original codebase-review
tickets 02 and 03 cover unwritten leases and unreadable tickets, not this
end-to-end lease duration.
