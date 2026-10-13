# 17: Surface credential-event subscription failures

**What to build:** oc-auth keeps reconnecting after credential-event failures,
but repeated subscription or processing failures are visible at normal log
levels. Expected shutdown and interruption remain quiet, and the active
credential still catches up with the host after reconnection.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Non-interruption failures of the event subscription or its processing emit
      an accurate, metadata-only warning and retain safe debug detail.
- [ ] Preserve bounded reconnect pacing and catch-up behavior; logging must not
      stop reconnection or reintroduce missed account switches.
- [ ] Treat expected interruption as cancellation, not a failed subscription. No
      new warnings appear merely because the plugin unloads.
- [ ] Define rate limiting or repetition policy for persistent failures so
      normal logs remain useful rather than being flooded indefinitely.
- [ ] Deterministic tests cover a failed subscription, downstream processing
      failure, successful reconnect, repeated failure, and clean teardown.
- [ ] Update the log documentation and run the repository checks.

## Coordination

Original codebase-review ticket 09 owns selection and reconnection correctness.
This follow-up adds failure visibility. Coordinate with follow-up ticket 09 on
pricing diagnostics so the records name the operation that actually failed.
