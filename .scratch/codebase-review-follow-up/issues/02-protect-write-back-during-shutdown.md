# 02: Protect write-back during plugin shutdown

**What to build:** An orderly plugin shutdown does not abandon newly issued
credentials before attempting to write them back. The review reproduced scope
closure interrupting write-back after a successful token exchange, releasing the
refresh lock while the replacement tokens never reached the credential store. If
the old refresh token has been consumed, this can require signing in again.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Define a bounded shutdown policy for the token-spend and write-back
      operation, including shutdown while the exchange is in flight and after
      replacement tokens have arrived.
- [ ] Once replacement tokens are available, ordinary shutdown gives guarded
      write-back its bounded completion opportunity rather than immediately
      discarding them. Do not introduce indefinitely uninterruptible work.
- [ ] Refresh-lock ownership covers protected write-back. If completion cannot
      be confirmed, emit a safe warning with actionable recovery guidance,
      without recording tokens or credential blobs.
- [ ] A regression explicitly closes the refresh service's scope after the
      endpoint answers and while write-back is held. Releasing the write lets it
      finish before teardown releases ownership.
- [ ] A second regression holds write-back indefinitely and proves shutdown is
      bounded and the incomplete operation is reported. Individual request
      cancellation still does not cancel another request's shared refresh.
- [ ] Use fake endpoint and store services with controlled time. Update the
      shutdown guarantee and run the repository checks.

## Coordination

Coordinate with follow-up ticket 01 for ownership during the shutdown grace
period. The tickets can be developed independently, but their combined behavior
must retain the same bound and ownership guarantee.
