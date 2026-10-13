# 09: Recover from failed pricing reloads

**What to build:** After the active credential changes, model pricing eventually
matches it even when the first host reload fails. The active credential must not
be rolled back merely to repair pricing. Currently the failure is debug-only,
and later reconciliation sees an already-served credential and skips repair.

**Blocked by:** None (can start immediately).

**Status:** ready-for-agent

- [ ] Track pending pricing work independently of whether the active credential
      already serves the host's selected Anthropic connection.
- [ ] Retry a failed reload with bounded pacing while the plugin is running;
      avoid busy loops, overlapping reload storms, and retries after teardown.
- [ ] A later account switch supersedes stale pending work, and eventual success
      reflects the latest active credential without disrupting requests.
- [ ] Warn safely when pricing reload fails and retain redacted details at debug
      level. A warning must not imply the credential switch itself failed.
- [ ] Deterministic tests cover failure followed by recovery without another
      switch, repeated failures, a newer switch, reconnect, and shutdown.
- [ ] Update pricing and logging documentation and run the repository checks.

## Coordination

Original codebase-review ticket 09 addresses credential selection and
reconnection. This follow-up addresses a pricing reload still pending after that
selection succeeds. Coordinate shared switch tests with follow-up tickets 17 and
20 without treating them as blockers.
